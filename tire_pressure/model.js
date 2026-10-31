/* Pressure Recommender 1.0 - pure, dependency-free model. SI inputs; gauge pressure in bar.
 * This is a chart-calibrated starting-point model, not a product approval,
 * a maximum-pressure formula, a measured 15%-drop model, or an optimum guarantee.
 * See ../RESEARCH.md and ../research/calibrate.py for evidence and assumptions.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PressureModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PSI_PER_BAR = 14.503773773;
  const KG_PER_LB = 0.45359237;
  const CONFIG = Object.freeze({ version: '1.0.0', referenceBar: 4.53,
    referenceLoadKg: 42.5, referenceWidthMm: 28, widthExponent: 1.5,
    tubeFloor: 1.00, impactFactor: 1.10 });
  const SURFACES = Object.freeze({
    smooth: { label: 'Very smooth pavement', factor: 1.05, basis: 'Heuristic, not separately fitted' },
    road: { label: 'Ordinary paved roads', factor: 1.00, basis: 'Road chart calibration' },
    rough: { label: 'Rough pavement / chipseal', factor: 0.90, basis: 'Heuristic, not separately fitted' },
    gravel: { label: 'Firm gravel / dirt roads', factor: 0.87, basis: 'Gravel chart calibration' },
    coarse: { label: 'Coarse, loose gravel', factor: 0.80, basis: 'Heuristic; published SILCA context check' },
    trail: { label: 'Moderate MTB trails', factor: 0.90, basis: 'ENVE trail chart calibration; not downhill' }
  });
  const BSDS = Object.freeze([305, 349, 355, 406, 451, 507, 540, 559, 584, 590, 622, 635]);
  const PRESETS = Object.freeze({
    city: {label:'City / upright',bikeKg:17,widthMm:47,bsd:622,frontShare:.40,surface:'road',system:'tube',impact:true},
    road: {label:'Road / endurance',bikeKg:9,widthMm:28,bsd:622,frontShare:.45,surface:'road',system:'tubeless',impact:false},
    gravel: {label:'Gravel / all-road',bikeKg:11,widthMm:40,bsd:622,frontShare:.45,surface:'gravel',system:'tubeless',impact:false},
    touring: {label:'Trekking / touring',bikeKg:15,widthMm:40,bsd:622,frontShare:.40,surface:'road',system:'tube',impact:true},
    mtb: {label:'MTB / moderate trail',bikeKg:14,widthMm:60.96,bsd:622,frontShare:.45,surface:'trail',system:'tubeless',impact:false},
    folding: {label:'Folding / compact',bikeKg:13,widthMm:40,bsd:406,frontShare:.40,surface:'road',system:'tube',impact:true}
  });
  function defaultState() {
    return { preset:'city', massUnit:'kg', widthUnit:'mm', pressureUnit:'bar', loadMode:'estimated',
      riderKg:79, bikeKg:17, gearKg:0, frontCargoKg:0, rearCargoKg:0, frontShare:.4,
      measuredFrontKg:null, measuredRearKg:null,
      frontWidthMm:47, rearWidthMm:47, sameWidth:true, frontBsd:622, rearBsd:622, sameWheel:true,
      widthBasis:'sidewall', system:'tube', surface:'road', impact:true };
  }
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  function basePressure(loadKg, widthMm, bsd) {
    if (![loadKg,widthMm,bsd].every(n => finite(n) && n > 0)) throw new RangeError('Positive finite load, width and bead-seat diameter required.');
    const wheelFactor = Math.sqrt((622 + 2 * widthMm) / (bsd + 2 * widthMm));
    return CONFIG.referenceBar * (loadKg / CONFIG.referenceLoadKg) *
      Math.pow(CONFIG.referenceWidthMm / widthMm, CONFIG.widthExponent) * wheelFactor;
  }
  function allocateLoad(s) {
    if (s.loadMode === 'measured') return { front:s.measuredFrontKg, rear:s.measuredRearKg,
      total:s.measuredFrontKg+s.measuredRearKg, method:'Measured, fully loaded bicycle' };
    const shared=s.riderKg+s.bikeKg+s.gearKg;
    return { front:shared*s.frontShare+s.frontCargoKg, rear:shared*(1-s.frontShare)+s.rearCargoKg,
      total:shared+s.frontCargoKg+s.rearCargoKg, method:'Estimated static distribution' };
  }
  /** Return errors instead of silently repairing invalid physical input. */
  function calculate(input) {
    const s={...input};
    if(s.sameWidth) s.rearWidthMm=s.frontWidthMm;
    if(s.sameWheel) s.rearBsd=s.frontBsd;
    const errors=[], notices=[];
    const add=(level,code,text) => notices.push({level,code,text});
    const check=(key,min,max,label) => { if(!finite(s[key])||s[key]<min||s[key]>max) errors.push({field:key,text:`${label} must be between ${min} and ${max}.`}); };
    if(!['estimated','measured'].includes(s.loadMode)) errors.push({field:'loadMode',text:'Choose a load input method.'});
    if(s.loadMode==='measured') { check('measuredFrontKg',5,120,'Front wheel load (kg)'); check('measuredRearKg',5,120,'Rear wheel load (kg)'); }
    else { check('riderKg',25,150,'Rider mass (kg)'); check('bikeKg',4,50,'Bike mass (kg)');
      check('gearKg',0,40,'On-body / central gear mass (kg)'); check('frontCargoKg',0,30,'Front cargo mass (kg)'); check('rearCargoKg',0,40,'Rear cargo mass (kg)');
      check('frontShare',.2,.8,'Front load fraction'); }
    for(const wheel of ['front','rear']) {
      check(wheel+'WidthMm',23,75,`${wheel==='front'?'Front':'Rear'} tire width (mm)`);
      if(!BSDS.includes(s[wheel+'Bsd'])) errors.push({field:wheel+'Bsd',text:'Select a supported bead-seat diameter.'});
    }
    if(!Object.hasOwn(SURFACES,s.surface)) errors.push({field:'surface',text:'Select a riding surface.'});
    if(!['tube','tubeless'].includes(s.system)) errors.push({field:'system',text:'Select an inner-tube or tubeless system.'});
    if(errors.length) return {valid:false,blocked:true,errors,notices,front:null,rear:null,loads:null};
    const loads=allocateLoad(s);
    if(loads.total<45 || loads.total>160) errors.push({field:'riderKg',text:'This model is limited to 45–160 kg total system mass. Use equipment-specific advice outside that range.'});
    if(loads.front<10 || loads.rear<10 || loads.front>110 || loads.rear>110) errors.push({field:'frontShare',text:'This model requires 10–110 kg on each wheel. Check your measurements or load distribution.'});
    if(errors.length) return {valid:false,blocked:true,errors,notices,front:null,rear:null,loads};
    if(loads.total<65 || loads.total>125 || s.frontWidthMm<25 || s.rearWidthMm<25 || s.frontWidthMm>62 || s.rearWidthMm>62)
      add('warn','extrapolation','This load or tire width lies beyond the main chart calibration. Treat the extrapolation cautiously and favor equipment-specific guidance.');
    if(s.frontBsd!==622 || s.rearBsd!==622)
      add('warn','small-wheel','Wheel diameter uses a geometry-based correction, not a directly validated small-wheel pressure table. Check your tire\'s limits, especially on folding bikes.');
    if(s.widthBasis!=='measured') add('info','nominal-width','Sidewall width is only an approximation. Measure the inflated tire across its casing; a small width difference can materially change this estimate.');
    if(s.loadMode==='estimated') add('info','estimated-load','The front/rear split is an editable assumption, not a property guaranteed by bike type. Cargo is treated as directly above its named axle; measure loads for overhanging cargo or unusual bicycles.');
    if(loads.front/loads.total<.3 || loads.front/loads.total>.65)
      add('warn','unusual-split','This is an unusual load distribution. Recheck axle measurements and the bicycle\'s handling and cargo limits.');
    const factor=SURFACES[s.surface].factor;
    const effectiveFactor=s.system==='tube'?Math.max(factor,CONFIG.tubeFloor):factor;
    if(s.system==='tube' && effectiveFactor>factor)
      add('info','tube-floor','A conservative inner-tube support floor replaces part of the low-pressure surface adjustment. This is a heuristic, not a guarantee against pinch flats; specialist TPU/latex setups need their own guidance.');
    if(s.impact) add('info','impact','The selected 10% impact allowance is a practical tuning margin, not a crash or rim-strike protection guarantee. Slow down or avoid sharp edges.');
    if(s.surface==='trail' && (s.frontWidthMm<45 || s.rearWidthMm<45))
      add('warn','narrow-trail','A narrow tire on MTB trails is outside the trail chart comparison. Do not treat this result as an endorsement of that setup.');
    const result={ valid:true,errors:[],notices,loads,factor,effectiveFactor,input:s };
    for(const wheel of ['front','rear']) {
      const name=wheel==='front'?'Front':'Rear';
      const base=basePressure(loads[wheel],s[wheel+'WidthMm'],s[wheel+'Bsd']);
      const raw=base*effectiveFactor*(s.impact?CONFIG.impactFactor:1);
      if(raw>10 || raw<.6) add('block',wheel+'-pressure-scope',`${name}: this result is outside the model's 0.6–10 bar working range. Use tire-specific guidance.`);
      result[wheel]={baseBar:base,rawBar:raw,recommendedBar:raw,loadKg:loads[wheel],widthMm:s[wheel+'WidthMm'],bsd:s[wheel+'Bsd']};
    }
    result.blocked=notices.some(n=>n.level==='block');
    if(result.blocked) for(const w of ['front','rear']) result[w].recommendedBar=null;
    return result;
  }
  /** Round for a pump. */
  function displayPressure(bar,unit='bar') {
    if(!finite(bar)) return {value:'—',unit};
    const scale = unit === 'psi' ? PSI_PER_BAR : 1;
    const places = unit === 'psi' ? 0 : 1;
    const step = 10 ** (-places);
    const rounded = Math.round(bar * scale / step) * step;
    return {value:rounded.toFixed(places),unit};
  }
  function evaluateBenchmarks(rows) {
    return rows.map(row=>{
      const s=defaultState();
      Object.assign(s,{riderKg:row.riderKg,bikeKg:row.bikeKg,frontShare:row.frontShare,
        frontWidthMm:row.widthMm,frontBsd:row.bsd,system:row.discipline==='city'?'tube':'tubeless',
        surface:row.discipline==='city'?'road':row.discipline,impact:row.discipline==='city',widthBasis:'measured'});
      const calc=calculate(s); // SILCA fixture uses total system as rider mass with zero bike mass: use measured mode.
      if(row.source==='SILCA') Object.assign(s,{loadMode:'measured',measuredFrontKg:(row.riderKg+row.bikeKg)*row.frontShare,measuredRearKg:(row.riderKg+row.bikeKg)*(1-row.frontShare)});
      const r=row.source==='SILCA'?calculate(s):calc;
      if(!r.valid) throw new Error('Invalid benchmark '+row.id+': '+JSON.stringify(r.errors));
      const frontPsi=r.front.rawBar*PSI_PER_BAR,rearPsi=r.rear.rawBar*PSI_PER_BAR;
      const meanPsi=(frontPsi+rearPsi)/2;
      return {...row,modelMeanPsi:meanPsi,modelFrontPsi:frontPsi,modelRearPsi:rearPsi,
        signedPercent:100*(meanPsi/row.referencePsi-1),absolutePercent:Math.abs(100*(meanPsi/row.referencePsi-1)),
        frontWithinRange:row.frontRangePsi?frontPsi>=row.frontRangePsi[0]&&frontPsi<=row.frontRangePsi[1]:null,
        rearWithinRange:row.rearRangePsi?rearPsi>=row.rearRangePsi[0]&&rearPsi<=row.rearRangePsi[1]:null};
    });
  }
  return Object.freeze({CONFIG,SURFACES,BSDS,PRESETS,PSI_PER_BAR,KG_PER_LB,defaultState,basePressure,allocateLoad,calculate,displayPressure,evaluateBenchmarks});
});
