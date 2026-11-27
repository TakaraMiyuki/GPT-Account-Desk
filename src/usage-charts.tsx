import { useEffect, useRef, useState } from 'react';

export type UsagePoint = {key: string; value: number | null; time?: number};

const shortNumber = new Intl.NumberFormat('zh-CN', {notation: 'compact', maximumFractionDigits: 2});
const shortKey = (key: string) => key.includes('T') ? key.slice(-5) : key.slice(5);
const xPosition = (points: UsagePoint[], index: number) => {
  const start = points[0]?.time;
  const end = points[points.length - 1]?.time;
  const time = points[index].time;
  return start != null && end != null && time != null && start < end
    ? (time - start) / (end - start) : (index + .5) / points.length;
};

export function UsageCharts({points, format, metric, hourly, mode, axisFormat}: {
  points: UsagePoint[]; format: (value: number) => string; metric: string; hourly: boolean;
  mode: 'line' | 'bar' | 'matrix'; axisFormat?: (value: number) => string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const point = points.find(item => item.key === picked);
  if (!points.some(item => item.value !== null)) return <p className="usage-empty">所选范围暂无可绘制的用量数据。</p>;
  const show = (item: UsagePoint) => item.key.replace('T', ' ') + ' · ' + (item.value === null ? '无记录' : format(item.value));
  const peak = points.reduce((max, item) => Math.max(max, item.value ?? 0), 0);
  const weekday = new Date(points[0].key.slice(0, 10) + 'T12:00').getDay();
  const offset = !hourly && Number.isFinite(weekday) ? (weekday + 6) % 7 : 0;
  return <>
    {mode !== 'matrix' ? <Plot points={points} mode={mode} title={metric + (mode === 'line' ? '折线图' : '柱状图')}
      pick={setPicked} axisFormat={axisFormat}/> : <>
    <div className="usage-matrix-heading"><h3>{metric}点阵图</h3><span>{hourly ? '每列 4 小时' : '每列 1 周 · 周一至周日'}</span></div>
    <div className="usage-matrix-scroll">
      <div className={hourly ? 'usage-matrix usage-matrix-hourly' : 'usage-matrix'}>
        {Array.from({length: offset}, (_, index) => <span key={index}/>)}
        {points.map(item => {
          const level = item.value === null ? 'missing' : item.value === 0 ? 'zero' : String(Math.ceil(item.value / peak * 4));
          return <button key={item.key} type="button" className={'usage-dot usage-dot-' + level} aria-label={show(item)}
            aria-pressed={picked === item.key} title={show(item)} onClick={() => setPicked(item.key)}
            onMouseEnter={() => setPicked(item.key)}/>;
        })}
      </div>
    </div>
    </>}
    <p className="usage-chart-caption">{point ? show(point) : '指向图表查看对应时段。'}</p>
  </>;
}

function Plot({points, mode, title, pick, axisFormat}: {
  points: UsagePoint[]; mode: 'line' | 'bar'; title: string; pick: (key: string) => void; axisFormat?: (value: number) => string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current!;
    const draw = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      const ctx = element.getContext('2d');
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      const left = 65, right = width - 12, top = 15, bottom = height - 26;
      const maximum = points.reduce((max, item) => Math.max(max, item.value ?? 0), 0);
      const ceiling = maximum > 0 ? maximum : 1;
      const spacing = Math.max(1, right - left) / points.length;
      ctx.font = '10px Segoe UI, sans-serif';
      ctx.fillStyle = '#65796c';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let level = 0; level <= 3; level++) {
        const y = bottom - (bottom - top) * level / 3;
        ctx.strokeStyle = '#e4e9e0';
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
        if (maximum || level === 0) ctx.fillText((axisFormat ?? shortNumber.format)(ceiling * level / 3), left - 7, y);
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#267153';
      ctx.fillStyle = mode === 'bar' ? '#459774' : '#267153';
      let prior: {x: number; y: number} | null = null;
      points.forEach((item, index) => {
        if (item.value === null) { prior = null; return; }
        const x = left + (right - left) * xPosition(points, index), y = bottom - item.value / ceiling * (bottom - top);
        if (mode === 'bar') {
          const size = Math.min(25, spacing * .68);
          ctx.fillRect(x - size / 2, y, size, Math.max(1, bottom - y));
        } else {
          if (prior) { ctx.beginPath(); ctx.moveTo(prior.x, prior.y); ctx.lineTo(x, y); ctx.stroke(); }
          ctx.beginPath(); ctx.arc(x, y, points.length > 45 ? 1.5 : 3, 0, Math.PI * 2); ctx.fill();
          prior = {x, y};
        }
      });
      ctx.fillStyle = '#65796c';
      const tickStep = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor((right - left) / 53))));
      let lastLabelEnd = left - 10;
      points.forEach((item, index) => {
        if (index % tickStep !== 0) return;
        const x = left + (right - left) * xPosition(points, index);
        const label = item.time == null ? shortKey(item.key) : item.key;
        const labelWidth = ctx.measureText(label).width;
        const labelLeft = Math.max(left, Math.min(x - labelWidth / 2, right - labelWidth));
        if (labelLeft <= lastLabelEnd) return;
        ctx.textAlign = 'left';
        ctx.fillText(label, labelLeft, height - 9);
        lastLabelEnd = labelLeft + labelWidth + 9;
      });
    };
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    draw();
    return () => observer.disconnect();
  }, [mode, points, axisFormat]);

  return <figure className="usage-plot">
    <figcaption>{title}</figcaption>
    <canvas ref={canvas} role="img" aria-label={title} onPointerMove={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const position = (event.clientX - bounds.left - 65) / Math.max(1, bounds.width - 77);
      if (position < 0 || position > 1 || !points.length) return;
      const closest = points.reduce((best, _, index) =>
        Math.abs(xPosition(points, index) - position) < Math.abs(xPosition(points, best) - position) ? index : best, 0);
      pick(points[closest].key);
    }}/>
  </figure>;
}
