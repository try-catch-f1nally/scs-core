import {Config} from './config.type';

export const CONFIG: Config = {
  apiUrl: 'http://localhost:3000',
  kafka: {
    brokerUrl: 'kafka:9092'
  },
  uploadStartAckTimeoutInSeconds: 60,
  uploadFinishAckTimeoutInSeconds: 120
};
