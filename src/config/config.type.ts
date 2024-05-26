import * as kafkajs from 'kafkajs';

export type Config = {
  apiUrl: string;
  kafka: {
    brokerUrl: string;
    clientConfig?: Omit<kafkajs.KafkaConfig, 'clientId' | 'brokers'>;
    producerConfig?: kafkajs.ProducerConfig;
    consumerConfig?: Omit<kafkajs.ConsumerConfig, 'groupId'>;
  };
  uploadStartAckTimeoutInSeconds: number;
  uploadFinishAckTimeoutInSeconds: number;
};
