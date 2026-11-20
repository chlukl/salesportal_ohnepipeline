// Starts the local dev stack (API :3000, worker, Vite :5173) independent of an inherited PORT variable
// (preview launchers set PORT to the web port, which would make the API server take it).
import { spawn } from 'node:child_process';

const env = { ...process.env, PORT: process.env.API_PORT ?? '3000' };
const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', env, shell: true });
const stop = (signal) => child.kill(signal);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
