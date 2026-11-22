<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import { CHART_COLORS, formatMoney } from '../utils'

const props = defineProps({ dashboard: { type: Object, default: null } })

const pieEl = ref(null), barEl = ref(null)
let pieChart = null, barChart = null

function render() {
  if (!pieChart || !barChart || !props.dashboard) return
  const d = props.dashboard
  const pieData = [
    { value: d.byDirection?.['对外'] || 0, name: '对外合同' },
    { value: d.byDirection?.['对内'] || 0, name: '对内合同' },
  ]
  pieChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', formatter: '{b}: {c} 份 ({d}%)' },
    legend: { bottom: 0, textStyle: { color: '#8aa2b5' } },
    color: CHART_COLORS,
    series: [{ type: 'pie', radius: ['45%', '68%'], center: ['50%', '44%'],
      label: { color: '#cfe6ff' }, data: pieData }],
  }, true)

  const statusOrder = ['草稿', '审批中', '已驳回', '已签署', '履约中', '已完成', '已终止', '已归档']
  const barData = statusOrder.map((s) => d.byStatus?.[s] || 0)
  barChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: 36, right: 12, top: 16, bottom: 24 },
    xAxis: { type: 'category', data: statusOrder.map((s) => s.replace('已', '')), axisLabel: { color: '#8aa2b5', fontSize: 10 }, axisLine: { lineStyle: { color: '#2b4a63' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8aa2b5' }, splitLine: { lineStyle: { color: 'rgba(80,120,150,.15)' } } },
    series: [{ type: 'bar', data: barData, itemStyle: { color: (p) => CHART_COLORS[p.dataIndex % CHART_COLORS.length], borderRadius: [4, 4, 0, 0] }, barMaxWidth: 26 }],
  }, true)
}

function initCharts() {
  if (pieEl.value) pieChart = echarts.init(pieEl.value)
  if (barEl.value) barChart = echarts.init(barEl.value)
  render()
}
function onResize() { pieChart?.resize(); barChart?.resize() }

onMounted(async () => { await nextTick(); initCharts(); window.addEventListener('resize', onResize) })
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); pieChart?.dispose(); barChart?.dispose() })
watch(() => props.dashboard, () => nextTick(render), { deep: true })
</script>

<template>
  <div class="charts-panel">
    <div class="chart-block"><div class="chart-title">对内 / 对外占比</div><div ref="pieEl" class="chart-canvas"></div></div>
    <div class="chart-block"><div class="chart-title">合同状态分布</div><div ref="barEl" class="chart-canvas"></div></div>
  </div>
</template>
