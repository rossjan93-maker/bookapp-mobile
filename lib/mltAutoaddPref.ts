import AsyncStorage from '@react-native-async-storage/async-storage';

export type MltAutoaddPref = 'always' | 'ask' | null;

const KEY = 'readstack_mlt_autoadd_pref_v1';

export async function getMltAutoaddPref(): Promise<MltAutoaddPref> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v === 'always' || v === 'ask') return v;
    return null;
  } catch {
    return null;
  }
}

export async function setMltAutoaddPref(v: MltAutoaddPref): Promise<void> {
  try {
    if (v === null) {
      await AsyncStorage.removeItem(KEY);
    } else {
      await AsyncStorage.setItem(KEY, v);
    }
  } catch {
  }
}
