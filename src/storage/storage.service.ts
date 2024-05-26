import stream from 'node:stream';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import timers from 'node:timers/promises';
import {promisify} from 'node:util';
import kafkajs from 'kafkajs';
import {AuthTokens, HttpClient} from '../httpClient/httpClient';
import {CONFIG} from '../config/config';

const UPLOAD_STREAM_TOPIC = 'upload-stream';
const UPLOAD_ACKNOWLEDGE_TOPIC = 'upload-acknowledge';
const DOWNLOAD_TOPIC = 'download-stream';

export type UploadOptions = {archiveName: string; encryptionKey?: string};
export type DownloadOptions = {archiveName: string; encryptionKey: string};
export type StorageServiceOptions = AuthTokens & {userId: string};
type BaseDownloadMessageValue = {userId: string; archiveName: string};
type DownloadStartMessage = {key: 'start'; value: BaseDownloadMessageValue & {checksum: string; iv: string}};
type DownloadDataMessage = {key: 'data'; value: BaseDownloadMessageValue & {data: string}};
type DownloadFinishMessage = {key: 'finish'; value: BaseDownloadMessageValue};

export type Archive = {
  userId: string;
  name: string;
  checksum?: string;
  iv?: string;
  sizeInBytes: number;
  createdAt: Date;
};

export class StorageService {
  private readonly _userId: string;
  private readonly _httpClient: HttpClient;
  private readonly _kafkaClient: kafkajs.Kafka;
  private readonly _kafkaProducer: kafkajs.Producer;
  private readonly _kafkaConsumer: kafkajs.Consumer;
  private _isKafkaConsumerReady = false;
  private _isKafkaProducerReady = false;

  constructor(options: StorageServiceOptions) {
    const {brokerUrl, clientConfig, consumerConfig, producerConfig} = CONFIG.kafka;
    const {userId, accessToken} = options;
    this._userId = userId;
    this._httpClient = new HttpClient(CONFIG.apiUrl, {authTokens: options});
    this._kafkaClient = new kafkajs.Kafka({
      ...clientConfig,
      clientId: userId,
      brokers: [brokerUrl],
      sasl: {
        ...clientConfig,
        mechanism: 'oauthbearer',
        oauthBearerProvider: () => Promise.resolve({value: accessToken})
      }
    });
    this._kafkaConsumer = this._kafkaClient.consumer({...consumerConfig, groupId: userId + '-consumer'});
    this._kafkaProducer = this._kafkaClient.producer(producerConfig);
  }

  async upload(readableStream: stream.Readable, options: UploadOptions) {
    const userId = this._userId;
    const {archiveName, encryptionKey = crypto.randomBytes(16).toString('hex')} = options;

    await this._ensureKafkaProducerReady();
    await this._ensureKafkaConsumerReady();

    await this._kafkaProducer.send({
      topic: UPLOAD_STREAM_TOPIC,
      messages: [{key: 'start', value: JSON.stringify({userId, archiveName})}]
    });
    await this._waitForAcknowledge('start');

    let dataOrderCounter = 0;
    const hash = crypto.createHash('md5');
    const iv = crypto.randomBytes(16).toString('base64');

    await new Promise<void>((resolve, reject) =>
      readableStream
        .on('data', async (data: Buffer) => {
          hash.update(data);
          const compressed = await promisify(zlib.gzip)(data);
          const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
          const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]).toString('base64');
          await this._kafkaProducer.send({
            topic: UPLOAD_STREAM_TOPIC,
            messages: [
              {
                key: 'data',
                value: JSON.stringify({
                  userId,
                  archiveName,
                  data: encrypted,
                  orderNumber: ++dataOrderCounter
                })
              }
            ]
          });
        })
        .on('close', async () => {
          const checksum = hash.digest('hex');
          await this._kafkaProducer.send({
            topic: UPLOAD_STREAM_TOPIC,
            messages: [{key: 'finish', value: JSON.stringify({userId, archiveName, iv, checksum})}]
          });
          resolve();
        })
        .on('err', async (err) => {
          await this._kafkaProducer.send({
            topic: UPLOAD_STREAM_TOPIC,
            messages: [{key: 'abort', value: JSON.stringify({userId, archiveName})}]
          });
          reject(err);
        })
    );

    await this._waitForAcknowledge('finish');

    return encryptionKey;
  }

  async download(writeableStream: stream.Writable, {archiveName, encryptionKey}: DownloadOptions) {
    const userId = this._userId;
    await this._httpClient.request({method: 'POST', path: `/archives/download/${userId}/${archiveName}`});

    await this._ensureKafkaConsumerReady();

    const hash = crypto.createHash('md5');
    let metadata: {checksum: string; iv: string};
    await this._kafkaConsumer.run({
      eachMessage: async (payload) => {
        if (payload.topic !== DOWNLOAD_TOPIC) {
          return;
        }

        const message = {
          key: payload.message.key!.toString(),
          value: payload.message.value!.toString()
        } as unknown as DownloadStartMessage | DownloadDataMessage | DownloadFinishMessage;

        if (userId !== message.value.userId || archiveName !== message.value.archiveName) {
          return;
        }

        if (message.key === 'start') {
          metadata = {checksum: message.value.checksum, iv: message.value.iv};
          return;
        }

        if (!metadata) {
          writeableStream.emit('error', `"${message.key}" message was received before "start" message`);
          return;
        }

        if (message.key === 'data') {
          const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, metadata.iv);
          const decrypted = decipher.update(Buffer.from(message.value.data, 'base64'));
          const uncompressed = await promisify(zlib.gunzip)(decrypted);
          hash.update(uncompressed);
          writeableStream.write(uncompressed, 'base64');
        } else if (message.key === 'finish') {
          if (hash.digest('hex') !== metadata.checksum) {
            writeableStream.emit('error', 'Checksum verification failed');
            return;
          }
        }
      }
    });
  }

  async list() {
    const response = await this._httpClient.request({method: 'GET', path: `/archives`});
    return response.body.json();
  }

  async delete(archiveName: string) {
    await this._httpClient.request({method: 'DELETE', path: `/archives/${this._userId}/${archiveName}`});
  }

  private async _ensureKafkaProducerReady() {
    if (!this._isKafkaProducerReady) {
      await this._kafkaProducer.connect();
    }
  }

  private async _ensureKafkaConsumerReady() {
    if (!this._isKafkaConsumerReady) {
      await this._kafkaConsumer.connect();
      await this._kafkaConsumer.subscribe({topics: [UPLOAD_ACKNOWLEDGE_TOPIC, DOWNLOAD_TOPIC]});
    }
  }

  private async _waitForAcknowledge(key: 'start' | 'finish') {
    return Promise.race([
      new Promise((resolve) =>
        this._kafkaConsumer.run({
          // eslint-disable-next-line @typescript-eslint/require-await
          eachMessage: async ({topic, message}) => {
            if (topic === DOWNLOAD_TOPIC && message.key?.toString() === key) {
              resolve(message.value?.toString());
            }
          }
        })
      ),
      timers.setTimeout(
        (key === 'start' ? CONFIG.uploadStartAckTimeoutInSeconds : CONFIG.uploadFinishAckTimeoutInSeconds) * 1000,
        () => {
          throw new Error(`Failed to wait for upload ${key} acknowledge: timeout error`);
        }
      )
    ]);
  }
}
