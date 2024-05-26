import * as undici from 'undici';
import {CONFIG} from '../config/config';

const refreshEndpoint = CONFIG.apiUrl + '/refresh';

export type AuthTokens = {accessToken: string; refreshToken: string};
type RefreshEndpointResponse = AuthTokens;
type HttpClientOptions = undici.Client.Options & {authTokens?: AuthTokens};

export class HttpClient extends undici.Client {
  private _authTokens?: AuthTokens;

  constructor(url: string | URL, options?: HttpClientOptions) {
    super(url, options);
    this._authTokens = options?.authTokens;
  }

  async request(options: undici.Dispatcher.RequestOptions & {includeAuthToken?: boolean}) {
    let response;
    if (options.includeAuthToken) {
      if (!this._authTokens) {
        throw new Error(
          'Failed to include authorization token in request: auth context is not configured for HTTP client instance'
        );
      }

      const {accessToken, refreshToken} = this._authTokens;
      const getOptionsWithAuthHeader = (options: undici.Dispatcher.RequestOptions) => ({
        ...options,
        headers: {...options.headers, authorization: `Bearer ${accessToken}`}
      });

      response = await super.request(getOptionsWithAuthHeader(options));
      if (response.statusCode === 401) {
        const refreshTokenResponse = await undici.request(refreshEndpoint, {
          // headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({refreshToken})
        });
        if (refreshTokenResponse.statusCode > 299) {
          throw new Error(`Failed to refresh authorization token; status code: ${refreshTokenResponse.statusCode}`);
        }

        this._authTokens = (await refreshTokenResponse.body.json()) as RefreshEndpointResponse;
        response = await super.request(getOptionsWithAuthHeader(options));
      }
    } else {
      response = await super.request(options);
    }

    return this._handleError(response);
  }

  private async _handleError(response: undici.Dispatcher.ResponseData) {
    if (response.statusCode > 299) {
      const body = await response.body.text();
      throw new Error(`HTTP request error: ${body}`);
    }
    return response;
  }
}
