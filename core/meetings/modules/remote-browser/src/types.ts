/** Platforms we can hold a logged-in session for. */
export type AuthPlatform = 'zoom' | 'google' | 'teams';

export type LoginStatusReason =
  | 'authenticated'
  | 'signed_out'
  | 'identity_mismatch'
  | 'identity_unknown'
  | 'check_failed';

export interface LoginStatus {
  loggedIn: boolean;
  reason: LoginStatusReason;
  /** Secret-free evidence suitable for operational logs. */
  detail: string;
}
