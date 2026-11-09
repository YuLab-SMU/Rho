// A screen recording of the application becomes the GIF that the documentation shows.
//
// ffmpeg is used twice: once to build a palette from the clip and once to encode with it,
// because a GIF's 256 colours have to come from the frames it actually shows. ImageMagick
// then stores only what changes between frames. Both are native tools on the machine that
// records; the encode is deterministic for a given source, size and frame rate.
//
//   node scripts/demo-gif.mjs ~/Desktop/recording.mov [-o docs/figures/demo.gif]
//
// The recording is not in the repository: it is large, and it is only the input. What is
// committed is the GIF this writes, at the size the pages show it.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const options = { output: 'docs/figures/demo.gif', width: 1000, fps: 10, 'trim-start': 0, 'trim-end': null };
const source = [];
const argv = process.argv.slice(2);
for (let at = 0; at < argv.length; at++) {
  const argument = argv[at];
  const name = argument === '-o' ? 'output' : argument.startsWith('--') ? argument.slice(2) : null;
  if (name === null) { source.push(argument); continue; }
  if (!(name in options) || at + 1 === argv.length) { process.stderr.write('unknown or incomplete option ' + argument + '\n'); process.exit(2); }
  options[name] = argv[++at];
}
if (source.length !== 1) {
  process.stderr.write('usage: node scripts/demo-gif.mjs <recording.mov> [-o <out.gif>] [--width 1000] [--fps 10]\n' +
    '                                [--trim-start <seconds>] [--trim-end <seconds>]\n');
  process.exit(2);
}
const output = path.resolve(options.output);
const width = Number(options.width);
const fps = Number(options.fps);
const added = Number(options['trim-start']); // seconds of the recording to drop at the start
const kept = options['trim-end'] === null ? null : Number(options['trim-end']); // seconds to keep, counted from the trim start

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', e => reject(new Error(command + ' could not start: ' + e.message)));
  child.on('close', code => code === 0 ? resolve() : reject(new Error(command + ' exited ' + code)));
});
const probe = command => new Promise(resolve => {
  const child = spawn(command, ['-version'], { stdio: 'ignore' });
  child.on('error', () => resolve(false));
  child.on('close', code => resolve(code === 0));
});

for (const tool of ['ffmpeg', 'ffprobe', 'magick']) if (!await probe(tool)) {
  process.stderr.write(tool + ' is not installed. Install ffmpeg and ImageMagick (brew install ffmpeg imagemagick).\n');
  process.exit(1);
}
try { await stat(source[0]); } catch { process.stderr.write('no such recording: ' + source[0] + '\n'); process.exit(1); }

// Scaled and decimated before the palette is built, so the palette describes what is kept.
const scale = 'fps=' + fps + ',scale=' + width + ':-1:flags=lanczos';
const trim = ['-ss', String(added), ...(kept === null ? [] : ['-t', String(kept)])];
const work = await mkdtemp(path.join(tmpdir(), 'rho-demo-gif-'));
try {
  const palette = path.join(work, 'palette.png');
  const raw = path.join(work, 'raw.gif');
  await run('ffmpeg', ['-v', 'error', '-y', ...trim, '-i', source[0], '-vf', scale + ',palettegen=stats_mode=diff:max_colors=256', '-frames:v', '1', palette]);
  await run('ffmpeg', ['-v', 'error', '-y', ...trim, '-i', source[0], '-i', palette, '-lavfi', scale + '[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-fps_mode', 'passthrough', raw]);
  await mkdir(path.dirname(output), { recursive: true });
  // Frame-by-frame deltas: without this every frame carries the whole window.
  await run('magick', [raw, '-layers', 'Optimize', output]);
} finally { await rm(work, { recursive: true, force: true }); }

const measured = await new Promise((resolve, reject) => {
  let text = '';
  const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate', '-show_entries', 'format=duration,size', '-of', 'default=noprint_wrappers=1', output]);
  child.stdout.on('data', d => { text += d; });
  child.on('close', code => code === 0 ? resolve(Object.fromEntries(text.trim().split('\n').map(l => l.split('=')))) : reject(new Error('ffprobe exited ' + code)));
});
process.stdout.write(output + ': ' + measured.width + 'x' + measured.height + ', ' + measured.r_frame_rate + ' fps, ' +
  measured.nb_read_frames + ' frames, ' + measured.duration + ' s, ' + measured.size + ' bytes\n');
