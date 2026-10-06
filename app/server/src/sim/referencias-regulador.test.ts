import { beforeAll, expect, it } from 'vitest';
import { ModuleDefSchema, type Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito } from './analisis.js';
let cat: ModuloCatalogo[];
beforeAll(async () => { cat = await loadCatalog(); });
const pines=[{name:'VIN',x:0,y:0,kind:'power'},{name:'OUT',x:0,y:1,kind:'power'},{name:'GND',x:0,y:2,kind:'ground'}];
const reg={...ModuleDefSchema.parse({type:'reg-referencia-prueba',name:'Reg',category:'Pruebas',svg:'x.svg',pins:pines}),modeloCodigo:`module.exports={circuito(ctx){ctx.regulador(ctx.pin('VIN'),ctx.pin('OUT'),ctx.pin('GND'),{voltios:3.3,caida:0.3,limiteA:0.1},'ldo')}}`};
const div={...reg,type:'div-nombres-prueba',modeloCodigo:`module.exports={circuito(ctx){ctx.resistencia(ctx.pin('VIN'),ctx.nodo('x-y'),1000,'r1');ctx.resistencia(ctx.nodo('x-y'),ctx.pin('GND'),1000,'r2');ctx.resistencia(ctx.pin('VIN'),ctx.nodo('x_y'),1000,'r3');ctx.resistencia(ctx.nodo('x_y'),ctx.pin('GND'),3000,'r4')}}`};
const buscar=(tipo:string)=>tipo===reg.type?reg:tipo===div.type?div:cat.find(m=>m.type===tipo);
const proyecto=(tipo:string):Project=>({schemaVersion:1,name:'referencias',board:'esp32-s3-devkitc-1',language:'micropython',modules:[{id:'board',type:'esp32-s3-devkitc-1',x:0,y:0,props:{usb:true}},{id:'m',type:tipo,x:0,y:0,props:{}}],wires:[{from:'board.5V',to:'m.VIN'},{from:'board.GND',to:'m.GND'},{from:'m.OUT',to:'board.GPIO6'}],sim:{wifiSsid:'x',wifiPassword:'y',autoReload:false}});
it('dos nodos internos de nombres similares conservan divisores separados',async()=>{
 const p=proyecto(div.type);p.wires=p.wires.filter(w=>w.from!=='m.OUT');
 const r=await analizarCircuito(p,buscar);
 expect(r.elementos.find(e=>e.id==='m.r1')?.vb).toBeCloseTo(2.5,2);
 expect(r.elementos.find(e=>e.id==='m.r3')?.vb).toBeCloseTo(3.75,2);
});
it('la salida de un regulador energizado y referenciado fija una entrada sin carga',async()=>{
 const r=await analizarCircuito(proyecto(reg.type),buscar,{direcciones:new Map([[6,{salida:false}]])});
 expect(r.entradas).toContainEqual(expect.objectContaining({gpio:6,nivel:1,flotante:false}));
});
it('un regulador sin entrada energizada no se inventa una referencia de salida',async()=>{
 const p=proyecto(reg.type);p.wires=p.wires.filter(w=>w.to!=='m.VIN');
 const r=await analizarCircuito(p,buscar,{direcciones:new Map([[6,{salida:false}]])});
 expect(r.entradas).toContainEqual(expect.objectContaining({gpio:6,nivel:null,flotante:true}));
});
it('un regulador en una isla alimentada pero sin retorno común sigue flotante respecto de la placa',async()=>{
 const p=proyecto(reg.type);
 p.modules.push({id:'f',type:'fuente-regulable',x:0,y:0,props:{voltage:5,currentLimitMa:1000}});
 p.wires=[{from:'f.V',to:'m.VIN'},{from:'f.GND',to:'m.GND'},{from:'m.OUT',to:'board.GPIO6'}];
 const r=await analizarCircuito(p,buscar,{direcciones:new Map([[6,{salida:false}]])});
 expect(r.entradas).toContainEqual(expect.objectContaining({gpio:6,nivel:null,flotante:true}));
});
