// Tiny SSE bus. The UI (and any curious agent) watches the harbor through this.

import type { ServerResponse } from 'node:http';

export class Bus {
  private clients = new Map<ServerResponse, (type: string, data: any) => boolean>();
  private history: { type: string; data: any; line: string }[] = [];
  private maxHistory = 300;

  attach(res: ServerResponse, replay = 20, visible: (type: string, data: any) => boolean = () => true): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(':ahoy\n\n');
    for (const event of this.history.filter((item) => visible(item.type, item.data)).slice(-replay)) res.write(event.line);
    this.clients.set(res, visible);
    const ping = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { /* closed */ }
    }, 15000);
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  emit(type: string, data: unknown): void {
    const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    this.history.push({ type, data, line });
    if (this.history.length > this.maxHistory) this.history.shift();
    for (const [res, visible] of this.clients) {
      if (!visible(type, data)) continue;
      try { res.write(line); } catch { this.clients.delete(res); }
    }
  }
}
