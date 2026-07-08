// ══════════════════════════════════════════════════════════════════
// signals.js — 桌面版(etf_monitor_v6.html)与手机版(etf_monitor_mobile.html)
// 共享的核心计算逻辑：持仓管理 + 信号计算。
//
// 这个文件存在的原因：7/3发现两个版本各自维护一份几乎相同的计算逻辑，
// 导致过bug（isTrialOnly没同步导致全仓/半仓显示矛盾、手机版confirmAddLot
// 漏更新full_shares导致仓位算错）。凡是纯计算、不依赖数据来源差异的逻辑，
// 统一放这里，两个HTML用 <script src="signals.js"> 引用，只维护一份。
//
// 不放在这里的（各自文件保留）：loadData()（数据源不同：本地文件 vs Gist）、
// exportPositions()里的Gist上传部分（仅桌面版需要）、buildCard/renderAll等
// UI渲染函数（本次暂不迁移，风险收益比不划算）。
//
// 手机版必须把这个文件也推到 GitHub Pages 所在的 etf-monitor 仓库，
// 不只是本地项目文件夹，否则手机版会加载不到这个文件。
// ══════════════════════════════════════════════════════════════════

// 交易成本：双边各按 万1.2，单笔最低5元
const FEE_RATE=0.00012, FEE_MIN=5;
function calcFee(amount){ return Math.max(amount*FEE_RATE, FEE_MIN); }

// 旧版数据结构迁移：早期版本用 {entry_date,entry_price,shares,entry_fee} 单笔字段，
// 现统一用 lots[] 数组(支持多笔建仓)。加载时自动转换，避免 pos.lots undefined 报错。
function migratePosition(pos){
  if(pos.lots) return pos; // 已是新结构
  pos.lots=[{date:pos.entry_date,price:pos.entry_price,shares:pos.shares,
    fee:pos.entry_fee!==undefined?pos.entry_fee:calcFee(pos.entry_price*pos.shares)}];
  delete pos.entry_date; delete pos.entry_price; delete pos.shares; delete pos.entry_fee;
  return pos;
}
function migrateHistoryEntry(h){
  if(h.lots) return h;
  h.lots=[{date:h.entry_date,price:h.entry_price,shares:h.shares,
    fee:h.entry_fee!==undefined?h.entry_fee:calcFee(h.entry_price*h.shares)}];
  delete h.entry_date; delete h.entry_price; delete h.shares; delete h.entry_fee;
  return h;
}

function loadPositions(){
  let p; try{p=JSON.parse(localStorage.getItem('etf_positions')||'{}')}catch(e){p={}}
  for(const code in p) p[code]=migratePosition(p[code]);
  return p;
}
function savePositions(){try{localStorage.setItem('etf_positions',JSON.stringify(positions))}catch(e){}}
function loadHistory(){
  let h; try{h=JSON.parse(localStorage.getItem('etf_trade_history')||'[]')}catch(e){h=[]}
  return h.map(migrateHistoryEntry);
}
function saveHistory(){try{localStorage.setItem('etf_trade_history',JSON.stringify(history))}catch(e){}}

// ── 持仓辅助：支持多笔建仓(lots) ──
function totalShares(pos){ return pos.lots.reduce((s,l)=>s+l.shares,0); }
// 含手续费的总成本(元)：每笔建仓的 价格×份数 + 该笔手续费
function totalCost(pos){ return pos.lots.reduce((s,l)=>s+l.price*l.shares+l.fee,0); }
// 加权平均成本价(不含手续费，仅用于展示)
function avgEntryPrice(pos){ const t=totalShares(pos); return pos.lots.reduce((s,l)=>s+l.price*l.shares,0)/t; }

// 某次卖出的净收益率：按"卖出份数/总份数"分摊总成本(含全部建仓本金+手续费)，扣除本次卖出手续费
function trancheReturn(pos, sellShares, sellPrice){
  const total=totalShares(pos);
  const cost=totalCost(pos)*(sellShares/total);
  const proceeds=sellPrice*sellShares-calcFee(sellPrice*sellShares);
  return proceeds/cost-1;
}

// 未实现浮盈：只扣"已实际发生"的入场手续费，不预估卖出手续费
// (卖出手续费取决于最终成交金额，补仓后可能超过5元下限，此刻无法确定，故不预估)
function unrealizedReturn(pos, price){
  const total=totalShares(pos);
  const cost=totalCost(pos)*(pos.remaining_shares/total); // 剩余份数分摊的含(入场)费成本
  const mktVal=price*pos.remaining_shares;
  return mktVal/cost-1;
}

// 根据"实际持仓状态(剩余份数/全仓基准份数)"将信号翻译为可执行建议
// pos: positions[code] 或 null
// full_shares: 用户定义的100%仓位对应份数（半仓入场时为买入份数的2倍）
// 信号给出的目标仓位(sig.pos_: 0/0.5/1) 低于当前剩余比例时 → 提示减仓/清仓
// 若已持仓且今天出现新的入场触发(如MA10二级触发回踩) → 提示"可考虑补仓"
function actualSignal(sig, pos, etf){
  if(pos){
    const total=totalShares(pos);
    const fullBase = pos.full_shares || total;
    const remain=pos.remaining_shares/fullBase, target=sig.pos_;

    // 计算持仓天数和最短持仓要求
    const firstDate=pos.lots[0].date;
    const holdDays=Math.max(0,Math.round((Date.now()-new Date(firstDate))/86400000));
    const minHold=(etf&&etf.type==='宽基稳定')?20:15;
    const canExit=holdDays>=minHold;

    // ── 止损判断（不受最短持仓限制，优先级最高）──────────────────────
    const price = sig.close || 0;
    if(price > 0 && etf){
      // 固定止损：基于入场均价
      const _avgP = pos.lots.reduce((s,l)=>s+l.price*l.shares,0) / total;
      const fixStop = _avgP * (1 - etf.fs);
      // ATR移动止损：直接用sig.atr_stop
      const atrStop = parseFloat(sig.atr_stop) || 0;
      const stop = Math.max(fixStop, atrStop);
      if(stop > 0 && price <= stop){
        const reason = price <= fixStop ? '固定止损' : 'ATR移动止损';
        return {type:`🚨 止损出场 (${reason})`,color:'var(--red)',dot:'var(--red)',
                sellShares:pos.remaining_shares,toFrac:0,addSignal:false,
                zeroReason:'stop',canExit:true,isStop:true};
      }
    }

    if(target < remain - 0.001){
      const sellShares=round100((remain-target)*fullBase, pos.remaining_shares);
      if(target<=0){
        const reasonTag = sig.zeroReason==='chop' ? '（震荡观望，非止损）' : '（趋势走坏）';
        if(canExit){
          // 满足最短持仓，红色立即执行
          const reasonColor = sig.zeroReason==='chop' ? 'var(--amber)' : 'var(--red)';
          return {type:`建议清仓${reasonTag}`,color:reasonColor,dot:reasonColor,
                  sellShares:pos.remaining_shares,toFrac:0,addSignal:false,
                  zeroReason:sig.zeroReason,canExit:true};
        } else {
          // 未满最短持仓，橙色警示，不可主动平仓
          const daysLeft=minHold-holdDays;
          const exitLabel = sig.zeroReason==='chop' ? '震荡观望' : '趋势走坏';
          return {type:`出场信号 [${exitLabel}] (未满最短持仓)`,color:'var(--amber)',dot:'var(--amber)',
                  sellShares:0,toFrac:remain,addSignal:false,
                  zeroReason:sig.zeroReason,canExit:false,daysLeft,minHold};
        }
      }
      return {type:`建议减仓至${Math.round(target*100)}%`,color:'var(--amber)',dot:'var(--amber)',sellShares,toFrac:target,addSignal:false,canExit:true};
    }
    if(sig.entry && target>=remain-0.001){
      const needsTop = remain < target - 0.05;
      // 判断实际触发方式：之前这里漏了confirmEntry分支，sig里也没导出这个字段，
      // 导致"趋势确认入场"触发的加仓一律被默认标成"回踩中轨MA30"，文案对不上实际原因
      // (2026-07-06发现：159732当天bounce=false/confirmEntry=true，卡片却显示"回踩中轨MA30")
      const entryVia = sig.bfast ? 'bfast' : sig.cxup ? 'cxup' : sig.bnce ? 'bnce' : sig.confirmEntry ? 'confirmEntry' : 'bnce';
      return {type:'持仓中（出现加仓信号）',color:'var(--blue)',dot:'var(--blue)',
              sellShares:0,addSignal:true,needsTop,entryVia,
              topShares:needsTop?Math.round((target-remain)*fullBase):0};
    }
    // ADX升级补仓：半仓持仓中 + ADX今日刚升破25（昨日<25）→ 提示补仓至全仓
    const adxJustCrossed = sig.trend_strong && sig.prevAdx!=null && sig.prevAdx < 25;
    if(adxJustCrossed && remain < 0.99){
      return {type:'持仓中 (ADX升级 -> 建议补仓至全仓)',color:'var(--blue)',dot:'var(--blue)',sellShares:0,addSignal:false,adxUpgrade:true};
    }
    if(sig.trend_strong) return {type:'持仓中（趋势强）',color:'var(--green)',dot:'var(--green)',sellShares:0,addSignal:false};
    if(sig.trend_weak)   return {type:'持仓中（趋势偏弱）',color:'var(--amber)',dot:'var(--amber)',sellShares:0,addSignal:false};
    return {type:'持仓中',color:'var(--green)',dot:'var(--green)',sellShares:0,addSignal:false};
  }
  if(sig.entry&&sig.isTrialOnly) return {type:'建议入场（半仓·试用期）',color:'var(--green)',dot:'#73c69e',sellShares:0,addSignal:false};
  if(sig.entry&&sig.trend_strong) return {type:'建议入场（全仓）',color:'var(--green)',dot:'var(--green)',sellShares:0,addSignal:false};
  if(sig.entry&&sig.trend_weak)   return {type:'建议入场（半仓）',color:'var(--green)',dot:'#73c69e',sellShares:0,addSignal:false};
  return {type:'空仓观望',color:'var(--text3)',dot:'var(--text4)',sellShares:0,addSignal:false};
}

// 把建议卖出份数四舍五入到100的整数倍（ETF最小交易单位=1手=100份），不超过剩余份数，至少100
function round100(n, max){
  let r=Math.round(n/100)*100;
  if(r<=0) r=100;
  return Math.min(r, max);
}

function togglePosForm(code,formId){
  const el=document.getElementById((formId||'pf-')+code);
  if(el) el.style.display = el.style.display==='none'?'flex':'none';
}

// 买入 = 入场 = 这只ETF的"全仓"基准(100%)，记录实际买入份数(第一笔lot)
function confirmEntry(code){
  const d=document.getElementById('ed-'+code).value;
  const p=parseFloat(document.getElementById('ep-'+code).value);
  const sh=parseInt(document.getElementById('es-'+code).value);
  const fullEl=document.getElementById('ef-'+code);
  const full=fullEl?parseInt(fullEl.value)||sh:sh;
  if(!d||!p||p<=0||!sh||sh<=0){alert('请输入有效的入场日期、价格和份数');return;}
  const fee=calcFee(p*sh);
  positions[code]={lots:[{date:d,price:p,shares:sh,fee}],remaining_shares:sh,full_shares:full,sells:[]};
  savePositions(); renderAll();
}

// 补仓：在已有持仓上新增一笔建仓记录(lot)。"全仓"基准重新定义为补仓后的总份数
function confirmAddLot(code){
  const d=document.getElementById('ad-'+code).value;
  const p=parseFloat(document.getElementById('ap-'+code).value);
  const sh=parseInt(document.getElementById('as-'+code).value);
  if(!d||!p||p<=0||!sh||sh<=0){alert('请输入有效的补仓日期、价格和份数');return;}
  const pos=positions[code];
  const fee=calcFee(p*sh);
  pos.lots.push({date:d,price:p,shares:sh,fee});
  pos.remaining_shares+=sh;
  // 补仓后全仓基准更新为总持仓份数
  pos.full_shares=pos.remaining_shares;
  savePositions(); renderAll();
}

// 撤销最近一次补仓：移除最后一笔lot(仅当该lot尚未被部分卖出，即remaining足够时可撤销)
function undoLastLot(code){
  const pos=positions[code];
  if(!pos||pos.lots.length<=1) return; // 至少保留一笔(首次建仓)
  const last=pos.lots[pos.lots.length-1];
  if(last.shares>pos.remaining_shares){
    alert('该笔补仓的部分份数已被卖出，无法直接撤销');return;
  }
  pos.lots.pop();
  pos.remaining_shares-=last.shares;
  savePositions(); renderAll();
}

// 卖出(减仓/清仓)：sh = 本次卖出份数（不超过剩余份数）
// remaining_shares 减少sh；若减到0则归档到复盘历史
function confirmSell(code){
  const d=document.getElementById('xd-'+code).value;
  const p=parseFloat(document.getElementById('xp-'+code).value);
  const sh=parseInt(document.getElementById('xs-'+code).value);
  const pos=positions[code];
  if(!d||!p||p<=0||!sh||sh<=0){alert('请输入有效的卖出日期、价格和份数');return;}
  if(sh>pos.remaining_shares){alert(`卖出份数不能超过剩余持仓(${pos.remaining_shares}份)`);return;}
  pos.sells.push({date:d,price:p,shares:sh});
  pos.remaining_shares-=sh;

  if(pos.remaining_shares<=0){
    const etf=etfData.etfs[code];
    const total=totalShares(pos);
    const totalRet=pos.sells.reduce((s,x)=>s+(x.shares/total)*trancheReturn(pos,x.shares,x.price),0);
    const firstDate=pos.lots[0].date;
    const lastDate=pos.sells[pos.sells.length-1].date;
    const days=Math.max(0,Math.round((new Date(lastDate)-new Date(firstDate))/86400000));
    history.unshift({code,name:etf.rt_name||etf.name,
      lots:pos.lots,
      exit_date:lastDate,ret:totalRet,days,n_sells:pos.sells.length,
      sells:pos.sells});
    delete positions[code];
    saveHistory();
  }
  savePositions(); renderAll();
}

// 撤销上一次减仓：把最近一笔卖出记录退回，份数加回剩余持仓
function undoLastSell(code){
  const pos=positions[code];
  if(!pos||!pos.sells||pos.sells.length===0) return;
  const last=pos.sells.pop();
  pos.remaining_shares+=last.shares;
  savePositions(); renderAll();
}

function deleteTrade(idx){
  if(!confirm('确认删除这条复盘记录？此操作不可恢复(若要撤销清仓请用"撤销清仓")。')) return;
  history.splice(idx,1); saveHistory(); renderAll();
}

// 撤销清仓：把复盘记录恢复为"持仓中"，去掉最后一次卖出，可重新标记
function undoClose(idx){
  const h=history[idx];
  const last=h.sells[h.sells.length-1];
  positions[h.code]={
    lots:h.lots,
    remaining_shares:last.shares,
    sells:h.sells.slice(0,-1)
  };
  history.splice(idx,1);
  savePositions(); saveHistory(); renderAll();
}

function clearPosition(code){
  if(!confirm('确认删除该持仓记录？此操作不会记入复盘历史。')) return;
  delete positions[code]; savePositions(); renderAll();
}

/* ── 技术指标（与回测一致）── */
const ma=(a,w)=>a.map((_,i)=>i<w-1?null:a.slice(i-w+1,i+1).reduce((x,y)=>x+y,0)/w);

function calcInd(bars,fast,mid,slow){
  const C=bars.map(b=>b[2]),H=bars.map(b=>b[3]),L=bars.map(b=>b[4]),V=bars.map(b=>b[5]);
  // bars格式: [date, open, close, high, low, vol]
  const maf=ma(C,fast),mam=ma(C,mid),mas=ma(C,slow);
  const tr=C.map((_,i)=>i===0?H[i]-L[i]:Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));
  const atr14=ma(tr,14);
  const rp=H.map((_,i)=>i===0?0:H[i]-H[i-1]),rm=H.map((_,i)=>i===0?0:L[i-1]-L[i]);
  const pdm=rp.map((p,i)=>p>rm[i]&&p>0?p:0),mdm=rm.map((m,i)=>m>rp[i]&&m>0?m:0);
  const a14=ma(tr,14);
  const pdi=ma(pdm,14).map((p,i)=>a14[i]?100*p/a14[i]:0);
  const mdi=ma(mdm,14).map((m,i)=>a14[i]?100*m/a14[i]:0);
  const dx=pdi.map((p,i)=>{const s=p+mdi[i];return s?100*Math.abs(p-mdi[i])/s:0;});
  const adx=ma(dx,14);
  const slope=maf.map((m,i)=>{const p=maf[i-5];return m&&p?(m-p)/p*100:null;});
  return bars.map((_,i)=>({
    date:bars[i][0],close:C[i],high:H[i],low:L[i],
    maf:maf[i],mam:mam[i],mas:mas[i],
    atr14:atr14[i],pdi:pdi[i],mdi:mdi[i],adx:adx[i],slope:slope[i]
  })).filter(r=>r.maf&&r.mam&&r.mas&&r.atr14&&r.adx!=null);
}

// 趋势确认入场：连续CONFIRM_DAYS天满足ts(或tw，且当天不满足ts)，即使从未金叉/回踩也直接入场
// 用于捕捉"确认趋势后一路陡拉、几乎不给回踩机会"的行情，逐标的由trend_confirm开关控制(见etf_fetch.py)
// 回测依据：tune_etf_config.py，全历史真实K线验证，对高波动主题类通常有效，对低波动/宽基类可能放大回撤
const CONFIRM_DAYS=3;
function isTsAt(r){const sl=r.slope||0; return r.maf>r.mam&&r.mam>r.mas&&r.close>r.mam&&sl>0.2&&r.adx>=25;}
function isTwOnlyAt(r){
  if(isTsAt(r)) return false;
  const sl=r.slope||0;
  return r.maf>r.mam&&r.mam>r.mas&&r.close>r.mam&&sl>0&&r.adx>=18&&r.adx<25;
}
function countStreak(ind,i,testFn){
  let n=0;
  for(let k=i;k>=0;k--){ if(!testFn(ind[k])) break; n++; }
  return n;
}

// 单日的入场/趋势判定，供 getSignal 和"近期信号回顾"复用
// ma10Trigger=true时：强趋势(ts)中价格回踩快线(MA10/20 ±1.5%~2%)也视为入场触发
// 动态条件：ma10Trigger须为true，且当日ADX≥30，才实际激活二级触发
// ma10Trial/trendConfirmTrial：试用档(历史不足4年，全样本判定通过，见tune_etf_config.py)
// 试用档触发时entryAt只负责标记isTrialOnly，实际打对折的仓位逻辑在getSignal里处理
function entryAt(ind,i,ma10Trigger,trendConfirm,ma10Trial,trendConfirmTrial){
  if(i<1) return null;
  const r=ind[i],p=ind[i-1];
  const sl=r.slope||0;
  const ts=r.maf>r.mam&&r.mam>r.mas&&r.close>r.mam&&sl>0.2&&r.adx>=25;
  const tw=r.maf>r.mam&&r.mam>r.mas&&r.close>r.mam&&sl>0&&r.adx>=18&&r.adx<25;
  const chop=r.adx<18;
  const cxup=p.maf<=p.mam&&r.maf>r.mam, bnce=r.low<=r.mam*1.015&&r.mam*0.99<=r.close&&r.close<=r.mam*1.02;
  let bfast=false;
  const ma10Active=(ma10Trigger||ma10Trial)&&ts&&r.adx>=30;  // 动态：ADX≥30才激活
  if(ma10Active){
    bfast=r.low<=r.maf*1.015&&r.maf*0.99<=r.close&&r.close<=r.maf*1.02;
  }
  let confirmEntry=false, confirmStreak=0;
  if(trendConfirm||trendConfirmTrial){
    const tsStreak=countStreak(ind,i,isTsAt);
    if(tsStreak>=CONFIRM_DAYS){confirmEntry=true; confirmStreak=tsStreak;}
    else{
      const twStreak=countStreak(ind,i,isTwOnlyAt);
      if(twStreak>=CONFIRM_DAYS){confirmEntry=true; confirmStreak=twStreak;}
    }
  }
  const entry=(cxup||bnce||bfast||confirmEntry)&&(ts||tw)&&!chop;
  // 是否"只能靠试用档机制才成立"的入场：只要任一触发路径是确认档(金叉/回踩/确认档bfast/确认档confirmEntry)，
  // 就不算试用档——即使试用档路径同时也触发了，也不该被拖累降级(2026-07-03修复：原公式只看
  // "有没有试用档路径触发"，没看"是否同时也有确认档路径独立触发"，导致588170这类bfast已是确认档、
  // 但trend_confirm_trial同时也触发时，被错误降级成半仓·试用期)
  const normalEntry=(cxup||bnce)&&(ts||tw)&&!chop;
  const bfastConfirmed=bfast&&ma10Trigger;
  const confirmEntryConfirmed=confirmEntry&&trendConfirm;
  const anyConfirmed=normalEntry||bfastConfirmed||confirmEntryConfirmed;
  const isTrialOnly=entry&&!anyConfirmed;
  return{entry,ts,tw,chop,cxup,bnce,bfast,ma10Active,confirmEntry,confirmStreak,isTrialOnly,date:r.date,close:r.close};
}

// 回顾最近几个交易日(不含今天)是否出现过未被捕捉的入场信号
// lookback=4 → 检查"昨天"到"4天前"，共4个交易日
function recentEntrySignals(ind,lookback=4,ma10Trigger,trendConfirm,ma10Trial,trendConfirmTrial){
  const n=ind.length, out=[];
  for(let back=1;back<=lookback;back++){
    const i=n-1-back;
    const e=entryAt(ind,i,ma10Trigger,trendConfirm,ma10Trial,trendConfirmTrial);
    if(e&&e.entry) out.push({date:e.date,type:(e.ts&&!e.isTrialOnly)?'全仓':'半仓',price:e.close,
      daysAgo:back,via:e.bfast?'回踩快线':e.cxup?'金叉':e.confirmEntry?'趋势确认':'回踩',trial:e.isTrialOnly});
  }
  return out; // daysAgo升序：最近的信号排第一
}

function getSignal(ind,cfg,pos=null){
  if(ind.length<3) return{type:'数据不足',color:'var(--text4)',pos_:0,dot:'var(--text4)',tbadge:'',alert_:''};
  const holding=!!pos;
  const r=ind[ind.length-1],p=ind[ind.length-2];
  const sl=r.slope||0;
  const e=entryAt(ind,ind.length-1,cfg.ma10_trigger,cfg.trend_confirm,cfg.ma10_trigger_trial,cfg.trend_confirm_trial);
  const{ts,tw,chop,entry,cxup,bnce,bfast,ma10Active,confirmEntry,confirmStreak,isTrialOnly}=e;
  const down=r.maf<r.mam||r.close<r.mas;
  const cxdn=p.maf>=p.mam&&r.maf<r.mam, brk=r.close<r.mas;
  const exit_=cxdn||brk;
  // ATR移动止损的峰值基准：持仓中用"入场以来最高价"（与etf_alert.py/回测一致，只涨不跌的真正移动止损）
  // 未持仓时用近20日最高价作为预览参考
  let hi;
  if(holding&&pos.lots&&pos.lots.length>0){
    const entryDate=pos.lots.reduce((min,l)=>l.date<min?l.date:min,pos.lots[0].date);
    const entryHighs=ind.filter(x=>x.date>=entryDate).map(x=>x.high);
    hi=entryHighs.length?Math.max(...entryHighs):r.high;
  }else{
    const last20=ind.slice(-20);
    hi=last20.length?Math.max(...last20.map(x=>x.high)):r.high;
  }
  const atrs=hi-cfg.atr_n*r.atr14, fxs=r.close*(1-cfg.fs);
  let type,color,pos_,dot,zeroReason='';
  if(chop||down){
    type='空仓观望';color='var(--text3)';pos_=0;dot='var(--text4)';
    // 区分"为什么是空仓"：止损/趋势走坏 vs 强度不足但方向未必差，纯展示用，不影响pos_判断
    zeroReason = down ? 'down' : 'chop';
  }
  else if(entry&&ts&&isTrialOnly){type='建议入场（半仓·试用期）';color='var(--green)';pos_=.5;dot='#73c69e';}
  else if(entry&&ts){type='建议入场（全仓）';color='var(--green)';pos_=1;dot='var(--green)';}
  else if(entry&&tw){type='建议入场（半仓）';color='var(--green)';pos_=.5;dot='#73c69e';}
  else if(ts&&!exit_){type='持仓中（趋势强）';color='var(--green)';pos_=1;dot='var(--green)';}
  else if(tw&&!exit_){type='持仓中（趋势偏弱）';color='var(--amber)';pos_=.5;dot='var(--amber)';}
  else if(exit_){type='建议出场';color='var(--red)';pos_=0;dot='var(--red)';}
  else{type='空仓观望';color='var(--text3)';pos_=0;dot='var(--text4)';}

  // 诊断明细：pos_降为0时，具体是哪个指标不达标——"趋势走坏"这个文案本身
  // 混合了好几种不同情况(死叉/跌破慢线/强度门槛卡在中间)，容易让人误以为均线已经破位
  let trendDiag='';
  if(pos_<=0){
    if(chop){
      trendDiag=`ADX(${r.adx.toFixed(1)}) < 18，震荡市不判断趋势方向`;
    }else if(down||exit_){
      trendDiag = cxdn ? `死叉：MA${cfg.fast}(${r.maf.toFixed(3)}) 跌破 MA${cfg.mid}(${r.mam.toFixed(3)})`
                       : `收盘价${r.close.toFixed(3)} 跌破慢线MA${cfg.slow}(${r.mas.toFixed(3)})`;
    }else{
      // 三线排列/价格位置本身仍正常，只是卡在"强/弱趋势"门槛之间——逐项找出具体卡在哪
      const order=r.maf>r.mam&&r.mam>r.mas, above=r.close>r.mam;
      const parts=[];
      if(!order) parts.push(`三线未按快>中>慢排列 (MA${cfg.fast}=${r.maf.toFixed(3)} MA${cfg.mid}=${r.mam.toFixed(3)} MA${cfg.slow}=${r.mas.toFixed(3)})`);
      else if(!above) parts.push(`收盘价${r.close.toFixed(3)} 未站上中线MA${cfg.mid}(${r.mam.toFixed(3)})`);
      else{
        const slopeOkTs=sl>0.2, adxOkTs=r.adx>=25, adxOkTw=r.adx>=18&&r.adx<25;
        if(!slopeOkTs) parts.push(`5日斜率仅${sl.toFixed(2)}%，未超过强趋势门槛0.2%`);
        if(slopeOkTs&&!adxOkTs) parts.push(`ADX(${r.adx.toFixed(1)})未达到强趋势门槛25`);
        if(!adxOkTw) parts.push(`ADX(${r.adx.toFixed(1)})已超出弱趋势区间[18,25)`);
        else if(!(sl>0)) parts.push(`斜率${sl.toFixed(2)}%未大于0`);
      }
      trendDiag = parts.length ? parts.join('；') : '趋势强度暂不满足持有门槛（三线排列/价格位置均正常，非破位）';
    }
  }
  let alert_='';
  if(cxup&&(ts||tw))   alert_=`g|⚡ 金叉: MA${cfg.fast} 上穿 MA${cfg.mid}`;
  else if(cxdn) alert_=`r|⚡ 死叉: MA${cfg.fast} 下穿 MA${cfg.mid}${holding?' ⚠️ 持仓中，注意出场条件':''}`;
  else if(bnce&&(ts||tw)&&r.pdi>r.mdi)  alert_=`a|📍 回踩中轨MA${cfg.mid} (${r.mam.toFixed(3)}) - 收盘需收阳且不低于MA${cfg.mid}，视为站稳信号`;
  else if(bnce&&(ts||tw)&&r.pdi<=r.mdi) alert_=`r|📍 回踩中轨MA${cfg.mid} (${r.mam.toFixed(3)}) - 空方占优，注意收盘是否跌破MA${cfg.mid}`;
  else if(bfast&&ts) alert_=`a|📍 回踩快线MA${cfg.fast} (${r.maf.toFixed(3)}) - 收盘需收阳且不低于MA${cfg.fast}，视为站稳信号${isTrialOnly?'（试用档二级触发，仅半仓，历史不足4年）':''}`;
  else if(confirmEntry) alert_=`p|🔶 趋势确认入场: ADX已持续${confirmStreak}天满足${ts?'强':'弱'}趋势条件，一直未出现回踩/金叉机会，直接入场（非常规触发，建议留意是否追高）${isTrialOnly?'\n⚠️ 试用档：历史不足4年，未经样本外验证，仅半仓，历史积累够后会自动转为确认档':''}`;
  const tbadge=ts?`<span class="tbg" style="background:var(--green-bg);color:var(--green)">趋势强</span>`
    :tw?`<span class="tbg" style="background:var(--amber-bg);color:var(--amber)">趋势偏弱</span>`
    :`<span class="tbg" style="background:var(--bg3);color:var(--text3)">无趋势</span>`;
  const adx5ago=ind.length>=6?ind[ind.length-6].adx:null;
  const adxDelta=adx5ago!=null?(r.adx-adx5ago):null;
  const prevAdx=ind.length>=2?ind[ind.length-2].adx:null;  // 昨日ADX，用于判断ADX是否刚升破25
  return{type,color,pos_,dot,alert_,tbadge,zeroReason,trendDiag,
    atrs:atrs.toFixed(3),fxs:fxs.toFixed(3),atrpct:((1-atrs/(r.close||1))*100).toFixed(1),
    maf:r.maf.toFixed(3),mam:r.mam.toFixed(3),mas:r.mas.toFixed(3),
    adx:r.adx.toFixed(1),pdi:r.pdi.toFixed(1),mdi:r.mdi.toFixed(1),
    adxDelta:adxDelta!=null?adxDelta.toFixed(1):null,
    prevAdx:prevAdx!=null?prevAdx:null,
    slope:sl.toFixed(2),date:r.date,atr14:r.atr14.toFixed(4),close:r.close,
    trend_strong:ts,trend_weak:tw,chop,entry,atr_stop:atrs,fix_stop:fxs,
    isTrialOnly,bfast,cxup,bnce,confirmEntry,confirmStreak,
    ma10_trigger:!!ma10Active};  // 动态：静态开关+ADX≥30才为true
}
