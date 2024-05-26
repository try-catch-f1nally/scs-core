import {AuthTokens, HttpClient} from '../httpClient/httpClient';
import {CONFIG} from '../config/config';

type RegisterResponse = AuthTokens & {userId: string};
type LoginResponse = AuthTokens & {userId: string};

export class AuthService {
  private readonly _httpClient = new HttpClient(CONFIG.apiUrl, {});

  async register(login: string, password: string) {
    const response = await this._httpClient.request({
      method: 'POST',
      path: '/register',
      body: JSON.stringify({login, password})
    });
    const body = await response.body.json();
    return body as RegisterResponse;
  }

  async login(login: string, password: string) {
    const response = await this._httpClient.request({
      method: 'POST',
      path: '/login',
      body: JSON.stringify({login, password})
    });
    const body = await response.body.json();
    return body as LoginResponse;
  }

  logout(refreshToken: string) {
    return this._httpClient.request({
      method: 'POST',
      path: '/logout',
      body: JSON.stringify({refreshToken})
    });
  }
}
