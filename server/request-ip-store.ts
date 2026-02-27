const requestIpStore = new WeakMap<Request, string>();

export function setRequestIp(req: Request, ip: string): void {
  requestIpStore.set(req, ip);
}

export function getRequestIp(req: Request): string | null {
  return requestIpStore.get(req) ?? null;
}
