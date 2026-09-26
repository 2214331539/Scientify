
const fs = require('fs');
const path = require('path');
const sharp = require('C:/Users/22143/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve(__dirname,'..');
const source=path.join(root,'source','master-transparent.png');
const sizes=[16,20,24,32,40,48,64,96,128,192,256,512,1024];
const icoSizes=[16,20,24,32,40,48,64,128,256];
const manifest=[];
function put(rel,b){const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b);}
async function save(rel,b,kind,theme,n){put(rel,b);manifest.push({file:rel,kind,theme,width:n,height:n});}
function ico(images){
 const h=Buffer.alloc(6+16*images.length);h.writeUInt16LE(1,2);h.writeUInt16LE(images.length,4);let pos=h.length;
 images.forEach(({n,b},i)=>{const o=6+16*i;h[o]=n===256?0:n;h[o+1]=n===256?0:n;h.writeUInt16LE(1,o+4);h.writeUInt16LE(32,o+6);h.writeUInt32LE(b.length,o+8);h.writeUInt32LE(pos,o+12);pos+=b.length;});return Buffer.concat([h,...images.map(x=>x.b)]);
}
(async()=>{
 const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let x0=info.width,y0=info.height,x1=0,y1=0;
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){if(data[(y*info.width+x)*4+3]>16){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}}
 const box={left:x0,top:y0,width:x1-x0+1,height:y1-y0+1};
 const alpha=await sharp(source).extract(box).extractChannel(3).toBuffer();
 async function glyph(n,theme,fill){
  const w=Math.round(n*fill),h=Math.round(w*box.height/box.width);
  const a=await sharp(alpha).resize(w,h,{kernel:'lanczos3'}).toBuffer();
  const c=theme==='light'?'#111111':'#ffffff';
  const mark=await sharp({create:{width:w,height:h,channels:3,background:c}}).joinChannel(a).png().toBuffer();
  return sharp({create:{width:n,height:n,channels:4,background:'#00000000'}}).composite([{input:mark,left:Math.floor((n-w)/2),top:Math.floor((n-h)/2)}]).png().toBuffer();
 }
 async function tile(n,theme){
  const hi=Math.max(n,256),light=theme==='light';
  const bg=light?'#f7f8fa':'#20242c',border=light?'#cdd1d8':'#727985';
  const svg=Buffer.from('<svg width="'+hi+'" height="'+hi+'" xmlns="http://www.w3.org/2000/svg"><rect x="'+hi*.035+'" y="'+hi*.035+'" width="'+hi*.93+'" height="'+hi*.93+'" rx="'+hi*.20+'" fill="'+bg+'" stroke="'+border+'" stroke-width="'+hi*.014+'"/></svg>');
  const mark=await glyph(hi,theme,.67);
  const composed=await sharp(svg).composite([{input:mark}]).png().toBuffer();
  return sharp(composed).resize(n,n).png().toBuffer();
 }
 for(const theme of ['light','dark']){
  for(const n of sizes){
   await save('app/'+theme+'/scientify-'+n+'.png',await glyph(n,theme,.80),'app',theme,n);
   await save('desktop/'+theme+'/scientify-'+n+'.png',await tile(n,theme),'desktop',theme,n);
  }
  for(const n of [16,20,24,32,40,48,64]){
   await save('taskbar/'+theme+'/scientify-'+n+'.png',await glyph(n,theme,n<=24?.90:.86),'taskbar',theme,n);
  }
  await save('master/scientify-'+theme+'-1024.png',await glyph(1024,theme,.80),'master',theme,1024);
  const desk=[],task=[];
  for(const n of icoSizes){desk.push({n,b:await tile(n,theme)});task.push({n,b:await glyph(n,theme,n<=24?.90:.86)});}
  put('desktop/scientify-'+theme+'.ico',ico(desk));
  put('taskbar/scientify-'+theme+'.ico',ico(task));
 }
 // Neutral app executable icon stays readable against light and dark backgrounds.
 fs.copyFileSync(path.join(root,'desktop/scientify-light.ico'),path.join(root,'desktop/scientify.ico'));
 for(const n of [180,192,512]){
  const b=await tile(n,'light');await save('web/icon-'+n+'.png',b,'web','light',n);
 }
 put('web/favicon.ico',ico(await Promise.all([16,32,48].map(async n=>({n,b:await tile(n,'light')})))));
 put('web/site.webmanifest',JSON.stringify({name:'Scientify',short_name:'Scientify',display:'standalone',background_color:'#f7f8fa',theme_color:'#f7f8fa',icons:[192,512].map(n=>({src:'icon-'+n+'.png',sizes:n+'x'+n,type:'image/png',purpose:'any'}))},null,2));
 // Static overview, plus native-size samples.
 const W=1440,H=1000,parts=[];
 const base=Buffer.from('<svg width="1440" height="1000" xmlns="http://www.w3.org/2000/svg"><rect width="720" height="1000" fill="#f7f8fa"/><rect x="720" width="720" height="1000" fill="#171a20"/></svg>');
 const labels=[];
 function txt(x,y,t,c='#222',size=22){labels.push('<text x="'+x+'" y="'+y+'" fill="'+c+'" font-family="Arial" font-size="'+size+'">'+t+'</text>');}
 txt(52,64,'SCIENTIFY / LOGO ASSET KIT','#111',28);
 txt(52,110,'LIGHT SURFACES','#666',16);txt(772,110,'DARK SURFACES','#b8bdc7',16);
 for(const [i,theme] of ['light','dark'].entries()){
  const off=i*720,c=i?'#ddd':'#333';
  parts.push({input:await glyph(300,theme,.80),left:off+60,top:160});
  parts.push({input:await tile(240,theme),left:off+420,top:185});
  txt(off+70,500,'IN-APP / TRANSPARENT',c,18);txt(off+430,500,'DESKTOP / TILE',c,18);
  txt(off+52,590,'TASKBAR / NATIVE PIXEL SIZES',c,18);
  let x=off+60;
  for(const n of [16,20,24,32,40,48,64]){
   parts.push({input:await glyph(n,theme,n<=24?.90:.86),left:x,top:630+Math.floor((64-n)/2)});
   txt(x,728,String(n),c,14);x+=88;
  }
  txt(off+52,820,'PNG 16-1024 / MULTI-SIZE WINDOWS ICO',c,18);
  txt(off+52,860,'Same silhouette. Theme-specific contrast.',c,17);
 }
 parts.push({input:Buffer.from('<svg width="'+W+'" height="'+H+'" xmlns="http://www.w3.org/2000/svg">'+labels.join('')+'</svg>')});
 put('preview.png',await sharp(base).composite(parts).png().toBuffer());
 put('manifest.json',JSON.stringify({brand:'Scientify',source:'source/original-logo.png',master:'source/master-transparent.png',themeMeaning:{light:'Dark mark for light surfaces',dark:'White mark for dark surfaces'},assets:manifest},null,2));
 const sections=['app','taskbar','desktop'].map(kind=>'<section><h2>'+({app:'App 内部',taskbar:'任务栏 / 托盘',desktop:'桌面图标'}[kind])+'</h2><div class="pair">'+['light','dark'].map(theme=>'<div class="panel '+theme+'"><h3>'+theme+'</h3><div class="samples">'+(kind==='taskbar'?[16,20,24,32,40,48,64]:[24,32,48,64,128,256]).map(n=>'<figure><img width="'+n+'" height="'+n+'" src="'+kind+'/'+theme+'/scientify-'+n+'.png"><figcaption>'+n+' px</figcaption></figure>').join('')+'</div></div>').join('')+'</div></section>').join('');
 put('preview.html','<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scientify Logo Kit</title><style>body{margin:32px;font:16px system-ui;background:#eceef1;color:#20242c}h1{font-size:32px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel{padding:24px;border-radius:20px}.light{background:#fff}.dark{background:#171a20;color:#fff}.samples{display:flex;gap:24px;align-items:center;flex-wrap:wrap}figure{margin:0;text-align:center}figcaption{margin-top:12px;font-size:12px;opacity:.65}img{object-fit:contain}section{margin:32px 0}a{color:inherit}@media(max-width:900px){.pair{grid-template-columns:1fr}}</style><h1>Scientify · Logo 素材库</h1><p>原生像素尺寸预览 · Light 为浅色界面使用，Dark 为深色界面使用。</p><p><a href="README.md">使用说明</a> · <a href="desktop/scientify.ico">默认 Windows 图标</a></p>'+sections+'</html>');
 // Validate all delivered PNG dimensions and alpha and ICO directory sizes.
 for(const a of manifest){const m=await sharp(path.join(root,a.file)).metadata();if(m.width!==a.width||m.height!==a.height||!m.hasAlpha)throw Error('Invalid PNG '+a.file);}
 for(const rel of ['desktop/scientify-light.ico','desktop/scientify-dark.ico','taskbar/scientify-light.ico','taskbar/scientify-dark.ico']){
  const b=fs.readFileSync(path.join(root,rel));if(b.readUInt16LE(4)!==icoSizes.length)throw Error('ICO frame count');
  for(let i=0;i<icoSizes.length;i++){let o=6+i*16;const len=b.readUInt32LE(o+8),start=b.readUInt32LE(o+12);const m=await sharp(b.subarray(start,start+len)).metadata();if(m.width!==icoSizes[i])throw Error('ICO dimensions');}
 }
 put('validation.json',JSON.stringify({pngFilesChecked:manifest.length,icoFilesChecked:4,icoFrameSizes:icoSizes,alpha:true,masterBounds:box,status:'passed'},null,2));
 console.log(JSON.stringify({root,pngCount:manifest.length,validation:'passed'}));
})().catch(e=>{console.error(e);process.exit(1)});

