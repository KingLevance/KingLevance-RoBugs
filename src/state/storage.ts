import Storage from 'expo-sqlite/kv-store';

export function loadString(key: string): string | null {
  try {
    return Storage.getItemSync(key);
  } catch {
    return null;
  }
}

export function saveString(key: string, value: string) {
  try {
    Storage.setItemSync(key, value);
  } catch {
    // Persistence is best-effort in the prototype.
  }
}
