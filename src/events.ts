// Tiny SSE bus. The UI (and any curious agent) watches the harbor through this.

import type { ServerResponse } from 'node:http';

export class Bus {
  private clients = new Set<ServerResponse>();
  private history: string[] = [];
  private maxHistory = 300;

  attach(res: ServerResponse, replay = 20): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(':ahoy\n\n');
    for (const line of this.history.slice(-replay)) res.write(line);
    this.clients.add(res);
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
    this.history.push(line);
    if (this.history.length > this.maxHistory) this.history.shift();
    for (const res of this.clients) {
      try { res.write(line); } catch { this.clients.delete(res); }
    }
  }
}
