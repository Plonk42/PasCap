/** Browser-only conveniences must never prevent loading or editing a project. */
export function readPreference(key: string): string | null {
    try { return localStorage.getItem(key); }
    catch { return null; }
}
export function writePreference(key: string, value: string): boolean {
    try { localStorage.setItem(key, value); return true; }
    catch { return false; }
}