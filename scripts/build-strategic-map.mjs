/**
 * Build an original, border-free historical game basemap from public-domain
 * Natural Earth geometry and explicitly schematic terrain/historical rivers.
 *
 * Rebuild: node scripts/build-strategic-map.mjs
 * Refresh geometry: node scripts/build-strategic-map.mjs --import-natural-earth
 *   (expects /tmp/sanguo-ne-50m-{land,rivers,lakes}.geojson)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const out = new URL('../src/assets/map/', import.meta.url);
await mkdir(out, { recursive: true });
const extent = { west: 93, east: 132, north: 43, south: 17 };
const width = 1800, height = 1500;
const project = ([lon, lat]) => [(lon - 93) / 39 * width, (43 - lat) / 26 * height];
const point = p => project(p).map(v => v.toFixed(1)).join(',');
const line = points => 'M' + points.map(point).join('L');
const polygon = points => line(points) + 'Z';
const fmt = n => Math.round(n * 10000) / 10000;
function flowingLine(coordinates) {
  const p = coordinates.map(project);
  let d = `M${p[0].map(v=>v.toFixed(1)).join(',')}`;
  for(let i=0;i<p.length-1;i++) {
    const a=p[Math.max(0,i-1)],b=p[i],c=p[i+1],e=p[Math.min(p.length-1,i+2)];
    const c1=[b[0]+(c[0]-a[0])/6,b[1]+(c[1]-a[1])/6];
    const c2=[c[0]-(e[0]-b[0])/6,c[1]-(e[1]-b[1])/6];
    d+=`C${[...c1,...c2,...c].map(v=>v.toFixed(1)).join(',')}`;
  }
  return d;
}

function clipRing(ring) {
  let result = ring.slice(0, -1);
  for (const [axis, boundary, direction] of [[0,93,1],[0,132,-1],[1,17,1],[1,43,-1]]) {
    const old = result; result = [];
    for (let i = 0; i < old.length; i++) {
      const a = old[i], b = old[(i+1) % old.length];
      const aInside = (a[axis] - boundary) * direction >= 0;
      const bInside = (b[axis] - boundary) * direction >= 0;
      if (aInside) result.push(a);
      if (aInside !== bInside) {
        const t = (boundary - a[axis]) / (b[axis] - a[axis]);
        result.push([a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1])]);
      }
    }
  }
  if (result.length < 3) return [];
  return [...result, result[0]].map(p => p.map(fmt));
}
function inside(p) { return p[0] >= 93 && p[0] <= 132 && p[1] >= 17 && p[1] <= 43; }
function geometryPolygons(g) { return g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }
function clippedPolygons(features) {
  return features.flatMap(f => geometryPolygons(f.geometry).map(rings => rings.map(clipRing).filter(r => r.length)).filter(r => r.length));
}
function splitLines(lines, predicate = inside) {
  return lines.flatMap(points => {
    const sections = []; let section = [];
    for (const p of points) {
      if (predicate(p)) section.push(p.map(fmt));
      else { if (section.length > 1) sections.push(section); section = []; }
    }
    if (section.length > 1) sections.push(section);
    return sections;
  });
}

if (process.argv.includes('--import-natural-earth')) {
  const read = async name => JSON.parse(await readFile(`/tmp/sanguo-ne-50m-${name}.geojson`, 'utf8'));
  const [land, rivers, lakes] = await Promise.all(['land','rivers','lakes'].map(read));
  const riverNames = new Set(['Gan','Han','Huang','Yuan','Chang Jiang','Dadu','Hong','Hongshui','Jinsha','Lancang','Liao','Min','Nanpan','Nu','Tongtian','Xi','Xun','Yangtze','Xar Moron']);
  const excludedLakes = new Set(['Nam Ngum Reservoir','Hongze Hu','Weishan Hu']);
  const local = {
    attribution: 'Natural Earth 1:50m physical vectors; public domain; clipped to game extent.',
    extent, land: clippedPolygons(land.features),
    rivers: rivers.features.filter(f => riverNames.has(f.properties.name)).flatMap(f => {
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
      // The eastern section is drawn below as a schematic Han–Tang river course.
      const paths = splitLines(lines, p => inside(p) && (f.properties.name !== 'Huang' || p[0] < 113.4));
      return paths.length ? [{name:f.properties.name, rank:f.properties.scalerank, paths}] : [];
    }),
    lakes: lakes.features.filter(f => !excludedLakes.has(f.properties.name) && f.properties.name).flatMap(f => {
      const polygons = clippedPolygons([f]);
      return polygons.length ? [{name:f.properties.name, polygons}] : [];
    })
  };
  await writeFile(new URL('geography.json', out), JSON.stringify(local));
}

const geography = JSON.parse(await readFile(new URL('geography.json', out), 'utf8'));
const landPath = geography.land.flatMap(rings => rings.map(polygon)).join('');

const terrainMasses = [
  {fill:'#82916c', opacity:.30, points:[[93,43],[99,42],[101,39],[103,36],[103,33],[101,29],[100,27],[98,25],[93,25]]},
  {fill:'#a79b68', opacity:.28, points:[[103,40],[108,41],[112,39],[112,36],[110,34.6],[106,34.4],[103,36]]},
  {fill:'#8c9c70', opacity:.23, points:[[99,29],[102,30],[104,28.5],[107,28.4],[111,27.8],[111,25],[108,23.5],[105,23],[101,22],[99,24]]},
  {fill:'#8a9a6a', opacity:.25, points:[[115,30.3],[118,30.8],[120.6,29.5],[120.5,26],[117,23],[113,23.8],[113,26.8]]},
  {fill:'#9ba675', opacity:.23, points:[[119,43],[125,43],[125,40],[123,38.8],[121.5,39.5],[120,41]]},
  {fill:'#e5dba9', opacity:.72, points:[[104,32.8],[106,32.6],[107.6,30.5],[106,28.7],[104,29],[103,30.2]]},
  {fill:'#e6ddaf', opacity:.6, points:[[113.6,38],[116.8,38.5],[118,37],[116.5,34],[119,32.5],[118,31],[114,32],[111.5,34.7]]},
];

// Terrain belts are decorative cartographic relief, never navigable geometry.
const mountainRanges = [
  {name:'祁连山', label:[99.8,38.9], angle:-28, strength:1.1, points:[[94,40],[96,39.3],[98,38.7],[100,38],[102,37.2]]},
  {name:'贺兰山', label:[105.5,39.2], angle:-77, strength:.7, points:[[105.7,39.6],[105.9,38.9],[105.8,38],[105.9,37.3]]},
  {name:'阴山', label:[109.8,41.4], angle:0, strength:.7, points:[[106.3,41],[108.3,41],[110.1,41],[112,41.3]]},
  {name:'太行山', label:[112.8,37.8], angle:70, strength:.8, points:[[114.6,40.2],[114.1,39.1],[113.5,38],[113.3,37],[112.6,36],[112.4,35.3]]},
  {name:'燕山', label:[117.9,40.9], angle:-7, strength:.65, points:[[115.5,40.8],[117,40.6],[118.5,40.6],[119.7,40.8]]},
  {name:'秦岭', label:[108.3,33.6], angle:0, strength:1.05, points:[[103.2,34.5],[105,34],[106.6,33.9],[108.3,33.8],[109.8,33.7],[111,33.6]]},
  {name:'大巴山', label:[107.4,31.9], angle:18, strength:.85, points:[[105.5,32.5],[107,32],[108.4,31.8],[109.6,31.4],[110.7,31.2]]},
  {name:'巫山', label:[110.6,30.4], angle:68, strength:.75, points:[[110.1,31.7],[109.8,31],[110.2,30.5],[110.6,30]]},
  {name:'大别山', label:[115.4,31.2], angle:-20, strength:.55, points:[[113.8,31.5],[114.9,31.2],[116,31.1],[117.1,30.9]]},
  {name:'武陵山', label:[109.5,28.8], angle:-48, strength:.7, points:[[108.1,29.8],[109,29],[109.8,28.1],[110.3,27.2]]},
  {name:'南岭', label:[112.6,25.2], angle:-5, strength:.8, points:[[109.5,25.2],[110.9,25.4],[112.3,25.3],[113.4,25.2],[114.6,25.5]]},
  {name:'武夷山', label:[117.5,27.3], angle:65, strength:.8, points:[[118.3,28.7],[117.5,27.8],[116.9,26.7],[116.4,25.8],[115.6,25.2]]},
  {name:'横断山', label:[99.2,31.6], angle:77, strength:1.2, points:[[98.6,34],[99,32.8],[99.4,31.5],[99.5,30.3],[99.8,29],[100.1,27.8],[100.2,26.2]]},
  {name:'龙门山', label:[103.2,31.6], angle:60, strength:.9, points:[[103,33.7],[103.5,32.6],[103.5,31.8],[102.8,30.8],[102.4,29.9]]},
  {name:'乌蒙山', label:[103.6,26.3], angle:-35, strength:.8, points:[[102.4,27.8],[103.3,27],[104.2,26.5],[104.8,25.8],[105.4,25.2]]},
  {name:'泰山', label:[117.1,36.1], angle:0, strength:.65, points:[[116.9,36.3],[117.5,36.2],[118.1,35.9],[118.6,35.3]]},
  {name:'长白山', label:[126.8,41.6], angle:55, strength:.8, points:[[124.5,41.5],[126,41.8],[127.3,41.7],[128.4,42.3],[129.4,42.7]]},
];

const supplementaryRivers = [
  {name:'黄河 · 汉唐故道示意', width:4.2, color:'#8c9f83', points:[[113.3987,34.9742],[113.8,35.13],[114.25,35.4],[114.8,35.6],[115.2,35.8],[115.5,36.12],[115.9,36.5],[116.5,36.8],[117.1,37.1],[117.7,37.35],[118.3,37.6],[118.75,37.85]]},
  {name:'渭水', width:2.5, points:[[104.1,35.1],[105.2,34.55],[106.2,34.3],[107.2,34.4],[108.2,34.35],[109.2,34.5],[110.2,34.6]]},
  {name:'汾水', width:2.1, points:[[112.3,38.7],[112.6,38],[112.5,37.6],[112,37],[111.6,36.6],[111.5,36],[111.25,35.6],[110.7,35.4]]},
  {name:'嘉陵江', width:2.7, points:[[106.6,33.6],[106.1,33],[105.8,32.4],[105.9,31.7],[106.1,31.2],[106.3,30.7],[106.1,30.3],[106.5,29.6]]},
  {name:'湘水', width:2.6, points:[[110.6,25.5],[111.3,26.2],[111.6,26.5],[112.5,26.9],[112.7,27.4],[112.95,28.1],[112.9,28.8],[113.1,29.1]]},
  {name:'淮水', width:2.6, points:[[113.3,32.4],[114.1,32.5],[114.8,32.3],[115.5,32.45],[116.2,32.6],[117.2,32.9],[118.3,33.1],[119,33.6],[119.6,34.1],[120.2,34.4]]},
  {name:'洛水', width:1.9, points:[[109.8,34.6],[110.4,34.1],[111.2,34.3],[112.2,34.6],[112.9,34.8]]},
  {name:'钱塘江', width:2.3, points:[[118.1,29.6],[118.7,29.8],[119.2,29.5],[119.7,29.8],[120.15,30.1],[120.7,30.3],[121.1,30.25]]},
  {name:'珠江', width:2.7, points:[[112.6,23.15],[113.05,23.1],[113.4,22.9],[113.55,22.5],[113.7,22.25]]},
];
const dongting = [[111.85,29.3],[112.3,29.55],[112.65,29.4],[113.1,29.55],[113.2,29.25],[112.95,28.9],[112.6,29.1],[112.4,28.85],[112.1,29.05],[111.85,29.3]];

let seed = 0x3a4129;
const random = () => {seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296;};
function mountainEtching(range) {
  let result = '';
  const projected = range.points.map(project);
  for(let i=1;i<projected.length;i++) {
    const a=projected[i-1], b=projected[i];
    const distance=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const count=Math.ceil(distance/17);
    for(let j=0;j<count;j++) {
      const t=j/count;
      for (let row=0;row<2;row++) {
        const x=a[0]+(b[0]-a[0])*t+(random()-.5)*16;
        const y=a[1]+(b[1]-a[1])*t+(row-.5)*22+(random()-.5)*14;
        const size=(9+random()*9)*range.strength;
        result += `<path d="M${(x-size).toFixed(1)},${(y+size*.4).toFixed(1)}q${(size*.5).toFixed(1)},${(-size*.6).toFixed(1)} ${size.toFixed(1)},${(-size*1.3).toFixed(1)}l${size.toFixed(1)},${(size*1.3).toFixed(1)}m${(-size).toFixed(1)},${(-size*1.3).toFixed(1)}l${(-size*.12).toFixed(1)},${size.toFixed(1)}"/>`;
      }
    }
  }
  return result;
}
function textAt(text, coordinates, {size=18, color='#50684f', opacity=.62, angle=0, spacing=4}={}) {
  const [x,y]=project(coordinates);
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" fill="${color}" opacity="${opacity}" letter-spacing="${spacing}" text-anchor="middle" transform="rotate(${angle} ${x.toFixed(1)} ${y.toFixed(1)})">${text}</text>`;
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1500" viewBox="0 0 1800 1500" role="img" aria-labelledby="title description">
  <title id="title">三国山河地理底图</title>
  <desc id="description">基于 Natural Earth 公共领域地理轮廓绘制。正北向上，东经93至132度、北纬17至43度等距映射。山脉为写意地形，汉魏黄河下游与洞庭湖为示意；不绘现代行政边界。</desc>
  <defs>
    <linearGradient id="sea" x2=".8" y2="1"><stop stop-color="#aec4b8"/><stop offset="1" stop-color="#8eada5"/></linearGradient>
    <linearGradient id="land" x2=".45" y2="1"><stop stop-color="#dbd6af"/><stop offset=".52" stop-color="#e5ddba"/><stop offset="1" stop-color="#c9cba0"/></linearGradient>
    <radialGradient id="vignette"><stop offset=".62" stop-color="#756345" stop-opacity="0"/><stop offset="1" stop-color="#756345" stop-opacity=".15"/></radialGradient>
    <pattern id="seaRipples" width="46" height="34" patternUnits="userSpaceOnUse"><path d="M2 8q8-4 16 0t16 0M24 25q6-3 12 0" fill="none" stroke="#476e66" stroke-width=".7" opacity=".13"/></pattern>
    <filter id="reliefSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="15"/></filter>
    <filter id="coastSoft" x="-4%" y="-4%" width="108%" height="108%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="paperTexture" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".32" numOctaves="3" seed="9" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".065"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/></filter>
    <clipPath id="landClip"><path d="${landPath}" fill-rule="evenodd"/></clipPath>
  </defs>
  <rect width="1800" height="1500" fill="url(#sea)"/>
  <rect width="1800" height="1500" fill="url(#seaRipples)"/>
  <path d="${landPath}" fill="#dae3c7" stroke="#dee6d0" stroke-width="17" opacity=".55" filter="url(#coastSoft)"/>
  <path d="${landPath}" fill="url(#land)" fill-rule="evenodd" stroke="#648776" stroke-width="1.8" stroke-linejoin="round"/>
  <g clip-path="url(#landClip)">
    <g filter="url(#reliefSoft)">${terrainMasses.map(t=>`<path d="${polygon(t.points)}" fill="${t.fill}" opacity="${t.opacity}"/>`).join('')}</g>
    <g fill="none" stroke-linecap="round" filter="url(#reliefSoft)">${mountainRanges.map(r=>`<path d="${flowingLine(r.points)}" stroke="#738b66" stroke-width="${42*r.strength}" opacity=".23"/>`).join('')}</g>
    <g fill="none" stroke="#64805e" stroke-width="1.2" opacity=".29" stroke-linejoin="round">${mountainRanges.map(mountainEtching).join('')}</g>
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      ${geography.rivers.map(r=>r.paths.map(p=>`<path d="${line(p)}" stroke="#f1e8c9" stroke-width="${r.rank<=3?7:4.5}" opacity=".8"/><path d="${line(p)}" stroke="${r.name==='Huang'?'#8c9f83':'#739a92'}" stroke-width="${r.rank<=3?3.9:2.2}" opacity=".9"/>`).join('')).join('')}
      ${supplementaryRivers.map(r=>`<path d="${flowingLine(r.points)}" stroke="#f1e8c9" stroke-width="${r.width+2.5}" opacity=".8"/><path d="${flowingLine(r.points)}" stroke="${r.color||'#739a92'}" stroke-width="${r.width}" opacity=".9"/>`).join('')}
    </g>
    <g fill="#93b2a8" stroke="#6e968a" stroke-width="1.1" opacity=".9">${geography.lakes.map(l=>l.polygons.map(rings=>`<path d="${rings.map(polygon).join('')}" fill-rule="evenodd"/>`).join('')).join('')}<path d="${polygon(dongting)}"/></g>
  </g>
  <g font-family="Songti SC, STSong, Noto Serif CJK SC, serif" font-weight="600">
    ${mountainRanges.map(r=>textAt(r.name,r.label,{size:17,angle:r.angle,opacity:.52})).join('')}
    ${textAt('黄 河',[108.6,40.6],{size:18,color:'#647b69',angle:1,opacity:.76})}
    ${textAt('黄 河',[116.5,37.3],{size:16,color:'#647b69',angle:-25,opacity:.76})}
    ${textAt('长 江',[114.2,29.9],{size:21,color:'#527b75',angle:16,opacity:.7})}
    ${textAt('汉 水',[111.5,32],{size:16,color:'#527b75',angle:30,opacity:.7})}
    ${textAt('淮 水',[116.1,33.2],{size:16,color:'#527b75',angle:0,opacity:.7})}
    ${textAt('渭 水',[107.4,34.8],{size:15,color:'#527b75',angle:0,opacity:.65})}
    ${textAt('洞庭',[112.55,29.15],{size:13,color:'#3f6c64',spacing:1,opacity:.8})}
    ${textAt('鄱阳',[116.2,29.1],{size:13,color:'#3f6c64',spacing:1,opacity:.8})}
    ${textAt('太湖',[120.1,31.05],{size:13,color:'#3f6c64',spacing:1,opacity:.8})}
    ${textAt('渤 海',[120,38.8],{size:29,color:'#4c746b',opacity:.43,spacing:8})}
    ${textAt('东 海',[126.3,29.5],{size:36,color:'#4c746b',opacity:.43,spacing:12})}
    ${textAt('南 海',[117.9,19.6],{size:36,color:'#4c746b',opacity:.43,spacing:12})}
    ${[['凉州',[99.6,37.2]],['并州',[110.4,38.4]],['幽州',[119.5,41.9]],['冀州',[115.3,38.3]],['青州',[119.5,36.8]],['益州',[104.6,30.5]],['荆州',[111.8,28]],['扬州',[118.8,27.9]],['交州',[108.7,22.5]]].map(([text,p])=>textAt(text,p,{size:38,color:'#847649',opacity:.22,spacing:10})).join('')}
  </g>
  <rect width="1800" height="1500" fill="url(#vignette)" pointer-events="none"/>
  <rect width="1800" height="1500" fill="#bfae83" opacity=".10" filter="url(#paperTexture)" pointer-events="none"/>
</svg>`;

await writeFile(new URL('strategic-map.svg', out), svg);
await writeFile(new URL('source-notes.json', out), JSON.stringify({
  title:'三国山河战略底图', generatedBy:'scripts/build-strategic-map.mjs',
  projection:{type:'equirectangular game projection',extent,width,height,x:'(longitude - 93) / 39 * 1800',y:'(43 - latitude) / 26 * 1500',orientation:'north up; no rotation'},
  sources:[
    {name:'Natural Earth 1:50m Land',license:'Public domain',url:'https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-land/',raw:'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson',usedFor:'Clipped land polygons and coastline; no administrative boundaries.'},
    {name:'Natural Earth 1:50m Rivers + Lake Centerlines',license:'Public domain',url:'https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-rivers-lake-centerlines/',raw:'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson',usedFor:'Major river lines. Eastern Huang He replaced by a schematic Han–Tang route.'},
    {name:'Natural Earth 1:50m Lakes',license:'Public domain',url:'https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-lakes/',raw:'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson',usedFor:'Selected natural lake outlines; named reservoir, Hongze and Weishan omitted.'},
    {name:'宁夏回族自治区水利厅：历史人物——王景',url:'https://slt.nx.gov.cn/slxc/jswm/dycr/202104/t20210409_2706718.html',usedFor:'Textual reference for Eastern Han Xingyang–Qiancheng Yellow River works; does not supply precise vector geometry.'}
  ],
  limitations:[
    'POC game basemap, not an archaeological or navigational map. Modern coastline is a geographic scaffold and does not reconstruct Han–Wei coastal sedimentation.',
    'Yellow River lower course is a hand-traced schematic toward Qiancheng near modern Lijin, based on the Han–Tang course; bends and historical shore intersection are approximate.',
    'Dongting Lake, several secondary rivers, mountain ranges and relief are schematic. Existing lake outlines are modern geographic references, not third-century survey data.',
    'Natural Earth geometry is generalized at 1:50 million; minor islands, streams and shoreline details are omitted. Equal degree spacing is used for predictable game placement, not equal distances.',
    'No contemporary national or provincial borders or sovereignty labels are drawn. Region titles are decorative historical names, not jurisdiction boundaries.'
  ]
}, null, 2)+'\n');
console.log(`Built ${fileURLToPath(new URL('strategic-map.svg', out))} (${Math.round(svg.length/1024)} KiB)`);
