import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { collaboration } from '../../platform/collaboration';
import { maskPhone } from './account';

/** The signed-in account's name, shared by the sidebar and Settings → 账号与订阅. */
export type Profile = { name: string; loaded: boolean };

const profileStore = createStore<Profile>(() => ({ name: '', loaded: false }));

export function useProfile() {
  return useStore(profileStore);
}

/** What to call the account: its name, or the masked phone number until it has one. */
export function accountLabel(name: string, phone: string | null | undefined) {
  return name || (phone ? maskPhone(phone) : '');
}

let loading: Promise<void> | null = null;
/** Reads the name once per sign-in; `again` reloads after an account change. */
export function loadProfile(again = false): Promise<void> {
  if (profileStore.getState().loaded && !again) return Promise.resolve();
  if (loading) return loading;
  loading = collaboration
    .account()
    .then((account) => profileStore.setState({ name: account.name ?? '', loaded: true }))
    .catch(() => {
      // Offline or signed out: the phone number stands in until the next try.
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function saveName(name: string): Promise<string> {
  const saved = await collaboration.setName(name.replace(/\s+/g, ' ').trim());
  profileStore.setState({ name: saved.name ?? '', loaded: true });
  return saved.name ?? '';
}

/** After signing out the next account starts without the previous name. */
export function forgetProfile() {
  profileStore.setState({ name: '', loaded: false });
}
