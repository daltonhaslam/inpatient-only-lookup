// A tiny static server for docs/, mimicking how Vercel serves it (directory indexes, 404.html).
//   node e2e/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv', '.xml': 'application/xml', '.txt': 'text/plain' };

export function serve(port = 0) {
  const server = createServer(async (request, response) => {
    let path = '';
    try {
      path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
    } catch {
      response.writeHead(400).end();
      return;
    }
    let file = join(root, path);
    if (!file.startsWith(root)) { response.writeHead(400).end(); return; }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      if (path.startsWith('/_vercel/')) { response.writeHead(200, { 'content-type': 'text/javascript' }).end(''); return; }
      response.writeHead(404, { 'content-type': TYPES['.html'] }).end(await readFile(join(root, '404.html')).catch(() => 'Not found'));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await serve(Number(process.argv[2]) || 4173);
  console.log(`http://127.0.0.1:${server.address().port}`);
}
