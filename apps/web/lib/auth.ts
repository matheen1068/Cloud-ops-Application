// Cognito sign-in through Amplify Auth (SRP: the password never leaves the browser in plain form).
import { Amplify } from 'aws-amplify';
import { fetchAuthSession } from 'aws-amplify/auth';
import type { AppConfig } from './config';

export {
  confirmSignUp,
  resendSignUpCode,
  signIn,
  signOut,
  signUp,
} from 'aws-amplify/auth';

export function configureAuth(config: AppConfig): void {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        loginWith: { email: true },
      },
    },
  });
}

/** The signed-in user's email, or null when nobody is signed in. */
export async function currentEmail(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    const email = session.tokens?.idToken?.payload.email;
    return typeof email === 'string' ? email : null;
  } catch {
    return null;
  }
}

/** ID token for API calls. Amplify refreshes it automatically when it expires. */
export async function idToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('Your session expired. Sign in again.');
  return token;
}
