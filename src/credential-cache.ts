const packedRefreshByAccessToken = new Map<string, string>();
const MAX_ENTRIES = 4;

export function rememberPackedRefresh(access: string, refresh: string): void {
  if (!access) return;
  if (packedRefreshByAccessToken.has(access)) packedRefreshByAccessToken.delete(access);
  while (packedRefreshByAccessToken.size >= MAX_ENTRIES) {
    const oldest = packedRefreshByAccessToken.keys().next().value;
    if (oldest === undefined) break;
    packedRefreshByAccessToken.delete(oldest);
  }
  packedRefreshByAccessToken.set(access, refresh);
}

export function getPackedRefresh(access: string): string | undefined {
  return packedRefreshByAccessToken.get(access);
}
