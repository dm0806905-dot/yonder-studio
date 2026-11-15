const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const OUTPUTS = path.join(DATA, 'clips');
const TEMP = path.join(DATA, 'temp');
[DATA, UPLOADS, OUTPUTS, TEMP].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/media', express.static(OUTPUTS));
const storage = multer.diskStorage({ destination: (_, __, cb) => cb(null, UPLOADS), filename: (_, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname || '.mp4').toLowerCase()}`) });
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } });
const jobs = new Map();
const clips = [];
function execute(command, args) { return new Promise((resolve, reject) => { const child=spawn(command,args); let stdout='',stderr=''; child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d); child.on('error',reject); child.on('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(stderr.slice(-1800)||`${command} terminó con código ${code}`))); }); }
const SUPPORTED_VIDEO_DOMAINS = ['youtube.com','youtu.be','kick.com','twitch.tv','vimeo.com','dailymotion.com','dailymotion.co','tiktok.com','vm.tiktok.com','x.com','twitter.com','facebook.com','fb.watch','instagram.com','reddit.com','streamable.com','rumble.com'];
function getPlatform(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./,'');
    const domain = SUPPORTED_VIDEO_DOMAINS.find(d => host === d || host.endsWith('.' + d));
    if (!domain) return null;
    if (domain === 'youtube.com' || domain === 'youtu.be') return 'YouTube';
    if (domain === 'kick.com') return 'Kick';
    if (domain === 'twitch.tv') return 'Twitch';
    if (domain === 'vimeo.com') return 'Vimeo';
    if (domain.startsWith('dailymotion')) return 'Dailymotion';
    if (domain === 'tiktok.com' || domain === 'vm.tiktok.com') return 'TikTok';
    if (domain === 'x.com' || domain === 'twitter.com') return 'X / Twitter';
    if (domain === 'facebook.com' || domain === 'fb.watch') return 'Facebook';
    if (domain === 'instagram.com') return 'Instagram';
    if (domain === 'reddit.com') return 'Reddit';
    if (domain === 'streamable.com') return 'Streamable';
    if (domain === 'rumble.com') return 'Rumble';
    return null;
  } catch { return null; }
}
function validVideoUrl(value) { try { const u=new URL(value); return ['http:','https:'].includes(u.protocol) && Boolean(getPlatform(value)); } catch { return false; } }
function update(job,status,progress,message) { Object.assign(job,{status,progress,message,updatedAt:new Date().toISOString()}); }
function outputSize(aspect,height) { if(aspect==='16:9')return {width:Math.round(height*16/9/2)*2,height}; if(aspect==='1:1')return {width:height,height}; return {width:Math.round(height*9/16/2)*2,height}; }
function publicError(message) { if(/Sign in|login required|bot|confirm.*not.*bot|HTTP Error 403/i.test(message))return 'La plataforma bloqueó la descarga o requiere iniciar sesión. Este enlace no está accesible desde el servidor; prueba otro enlace público o una fuente autorizada.'; if(/Unsupported URL|No suitable extractor|not a valid URL/i.test(message))return 'Este tipo de enlace no es compatible con el extractor disponible. Prueba el enlace directo del video o una plataforma compatible.'; if(/private video|This video is private|members-only/i.test(message))return 'Este video es privado o está restringido y no se puede procesar sin acceso autorizado.'; if(/ENOENT/.test(message))return 'Falta FFmpeg, ffprobe o yt-dlp en el servidor.'; if(/GROQ_API_KEY|OPENAI_API_KEY/.test(message))return 'La IA no está configurada. Añade GROQ_API_KEY en Render.'; return String(message).slice(-1000); }

async function extractAudioChunks(videoPath,jobId) {
  const pattern=path.join(TEMP,`${jobId}-audio-%04d.mp3`);
  await execute(process.env.FFMPEG_PATH||'ffmpeg',['-y','-i',videoPath,'-vn','-ac','1','-ar','16000','-b:a','48k','-f','segment','-segment_time','45','-reset_timestamps','1',pattern]);
  return fs.readdirSync(TEMP).filter(n=>n.startsWith(`${jobId}-audio-`)&&n.endsWith('.mp3')).sort().map((n,i)=>({path:path.join(TEMP,n),start:i*45,end:(i+1)*45}));
}
async function transcribe(chunk) {
  const apiKey=process.env.GROQ_API_KEY||process.env.OPENAI_API_KEY;
  if(!apiKey)throw new Error('Falta GROQ_API_KEY.');
  const form=new FormData();
  form.append('model',process.env.GROQ_API_KEY?(process.env.GROQ_TRANSCRIBE_MODEL||'whisper-large-v3-turbo'):(process.env.OPENAI_TRANSCRIBE_MODEL||'gpt-4o-mini-transcribe'));
  form.append('file',new Blob([fs.readFileSync(chunk.path)],{type:'audio/mpeg'}),path.basename(chunk.path));
  const base=process.env.GROQ_API_KEY?'https://api.groq.com/openai/v1':'https://api.openai.com/v1';
  const r=await fetch(`${base}/audio/transcriptions`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form});
  const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error?.message||`Error de transcripción OpenAI (${r.status})`); return String(d.text||'').trim();
}
async function selectMoments(transcript,total,count,duration) {
  const apiKey=process.env.GROQ_API_KEY||process.env.OPENAI_API_KEY;
  if(!apiKey)throw new Error('Falta GROQ_API_KEY.');
  const prompt=`Eres editor profesional de clips virales. Lee la transcripción temporal de un streamer y selecciona hasta ${count} momentos auténticamente atractivos. Prioriza bromas, remates, risas, reacciones, sorpresas, discusiones entretenidas, frases memorables y cambios emocionales. No inventes contexto ni afirmes que algo es gracioso sin señales en el texto. Video de ${total} segundos. Cada clip durará ${duration} segundos. Devuelve SOLO JSON: {"moments":[{"center_seconds":123,"score":94,"category":"Humor","title":"título corto","reason":"por qué destaca"}]}. score 1-100. Ordena mejor primero, evita solapamientos y sitúa centros dentro del video.\nTRANSCRIPCIÓN:\n${transcript.slice(0,85000)}`;
  const base=process.env.GROQ_API_KEY?'https://api.groq.com/openai/v1':'https://api.openai.com/v1';
  const model=process.env.GROQ_API_KEY?(process.env.GROQ_CHAT_MODEL||'openai/gpt-oss-20b'):(process.env.OPENAI_CHAT_MODEL||'gpt-4.1-mini');
  const r=await fetch(`${base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:'Seleccionas momentos reales para TikTok y YouTube Shorts. Devuelve JSON estricto.'},{role:'user',content:prompt}],response_format:{type:'json_object'},temperature:0.2,max_tokens:2200})});
  const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error?.message||`Error de análisis OpenAI (${r.status})`);
  const parsed=JSON.parse(d.choices?.[0]?.message?.content||'{}'); const maxStart=Math.max(0,total-duration); const selected=[];
  for(const m of (parsed.moments||[]).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0))){const center=Math.max(0,Math.min(total,Number(m.center_seconds)||0));const start=Math.max(0,Math.min(maxStart,Math.round(center-duration/2)));if(selected.every(x=>Math.abs(x.start-start)>=duration*.7))selected.push({start,score:Math.max(1,Math.min(100,Math.round(Number(m.score)||50))),category:String(m.category||'Destacado').slice(0,40),title:String(m.title||'Momento destacado').slice(0,100),reason:String(m.reason||'Seleccionado por análisis de IA.').slice(0,250)});if(selected.length>=count)break;}
  if(!selected.length)throw new Error('La IA no encontró momentos destacados en el audio.'); return selected;
}
async function processJob(job,source,isUrl) {
 let input=source; const audioFiles=[];
 try {
  update(job,'downloading',5,isUrl?('Descargando video de '+(getPlatform(job.sourceUrl)||'la plataforma')+'...'):'Preparando video subido...');
  if(isUrl){const template=path.join(UPLOADS,`${job.id}.source.%(ext)s`);await execute(process.env.YTDLP_PATH||'yt-dlp',['--no-warnings','--no-playlist','--merge-output-format','mp4','-f','bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b','-o',template,job.sourceUrl]);const f=fs.readdirSync(UPLOADS).find(n=>n.startsWith(`${job.id}.source.`));if(!f)throw new Error('No se encontró el video descargado.');input=path.join(UPLOADS,f);}
  update(job,'analyzing',12,'Midiendo el video y extrayendo audio...');const p=await execute(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',input]);const total=Math.floor(Number(p.stdout.trim()));if(!Number.isFinite(total)||total<3)throw new Error('No se pudo leer la duración del video.');
  const count=Math.max(1,Math.min(10,Number(job.options.count)||3));const duration=Math.min(Math.max(10,Math.min(180,Number(job.options.duration)||45)),total);const chunks=await extractAudioChunks(input,job.id);audioFiles.push(...chunks.map(c=>c.path));let transcript='';
  for(let i=0;i<chunks.length;i++){update(job,'transcribing',18+Math.round((i/chunks.length)*40),`La IA escucha el audio (${i+1}/${chunks.length})...`);const text=await transcribe(chunks[i]);if(text)transcript+=`\n[${chunks[i].start}-${Math.min(total,chunks[i].end)} s] ${text}`;}
  if(!transcript.trim())throw new Error('No se detectó voz clara en el video.');
  update(job,'selecting',62,'La IA está puntuando bromas, risas y reacciones...');const moments=await selectMoments(transcript,total,count,duration);const size=outputSize(job.options.aspect||'9:16',Number(job.options.quality)||1080);const made=[];
  for(let i=0;i<moments.length;i++){const m=moments[i],id=crypto.randomUUID(),filename=`${id}.mp4`,out=path.join(OUTPUTS,filename),seconds=Math.min(duration,total-m.start);update(job,'processing',66+Math.round(i/moments.length*32),`Renderizando clip IA ${i+1}/${moments.length}...`);const vf=`scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height}`;await execute(process.env.FFMPEG_PATH||'ffmpeg',['-y','-ss',String(m.start),'-i',input,'-t',String(seconds),'-vf',vf,'-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart',out]);const c={id,name:m.title||`Clip ${i+1}`,duration:seconds,resolution:`${size.width}×${size.height}`,url:`/media/${filename}`,filename,createdAt:new Date().toISOString(),jobId:job.id,score:m.score,category:m.category,reason:m.reason};clips.unshift(c);made.push(c);}
  job.clipIds=made.map(c=>c.id);update(job,'completed',100,`${made.length} clips elegidos por IA y listos para descargar.`);
 }catch(e){update(job,'failed',job.progress||0,'No se pudo completar el análisis.');job.error=publicError(e.message);console.error('Yonder job error:',e);}
 finally{for(const f of audioFiles)if(fs.existsSync(f))fs.unlinkSync(f);if(input&&input!==source&&fs.existsSync(input))fs.unlinkSync(input);if(!isUrl&&source&&fs.existsSync(source))fs.unlinkSync(source);}
}
app.get('/api/health',(_,res)=>res.json({status:'ok',service:'YONDER STUDIO',aiEnabled:Boolean(process.env.GROQ_API_KEY||process.env.OPENAI_API_KEY),aiProvider:process.env.GROQ_API_KEY?'Groq':(process.env.OPENAI_API_KEY?'OpenAI':'none')}));
app.get('/api/clips',(_,res)=>res.json({clips,jobs:[...jobs.values()].map(({id,status,createdAt})=>({id,status,createdAt}))}));
app.post('/api/jobs',upload.single('video'),(req,res)=>{if(!process.env.GROQ_API_KEY&&!process.env.OPENAI_API_KEY){if(req.file)fs.unlink(req.file.path,()=>{});return res.status(503).json({error:'La IA no está activada. Configura GROQ_API_KEY gratis en Render.'});}const options={duration:req.body.duration,count:req.body.count,aspect:req.body.aspect,quality:req.body.quality,projectName:req.body.projectName};const url=(req.body.url||'').trim();if(!req.file&&!validVideoUrl(url))return res.status(400).json({error:'Pega un enlace HTTPS de una plataforma compatible (YouTube, Kick, Twitch, Vimeo, Dailymotion, TikTok, X, Facebook, Instagram, Reddit, Streamable o Rumble) o sube un video.'});const id=crypto.randomUUID();const job={id,status:'queued',progress:0,message:'Trabajo en cola...',createdAt:new Date().toISOString(),options,sourceUrl:req.file?null:url,platform:req.file?'Archivo':getPlatform(url)};jobs.set(id,job);processJob(job,req.file?req.file.path:url,!req.file);res.status(202).json({job:{id,status:job.status}});});
app.get('/api/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Trabajo no encontrado.'});res.json({job:j});});
app.get('/api/clips/:id/download',(req,res)=>{const c=clips.find(x=>x.id===req.params.id);if(!c)return res.status(404).json({error:'Clip no encontrado.'});res.json({url:c.url,filename:c.filename});});
app.get('/',(_,res)=>res.sendFile(path.join(ROOT,'index.html')));
app.use((e,req,res,next)=>{console.error(e);res.status(400).json({error:e.message||'Solicitud incorrecta.'});});
app.listen(PORT,'0.0.0.0',()=>console.log(`YONDER STUDIO activo en ${PORT}`));
