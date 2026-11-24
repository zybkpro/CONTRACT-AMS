<script setup>
import { useTemplateRef, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import { formatMoney } from '../utils'

const props = defineProps({ dashboard: { type: Object, default: null } })

const pieEl = useTemplateRef('pieEl')
const barEl = useTemplateRef('barEl')
const amountEl = useTemplateRef('amountEl')
let pieChart = null, barChart = null, amountChart = null

// 渐变工具：顶部亮色 → 底部暗色，保持深色科技风；纯函数，无组件状态
function vGrad(from, to) {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: from },
    { offset: 1, color: to },
  ])
}
const gradIncome = () => vGrad('#6ef0ff', '#1287c4')
const gradExpense = () => vGrad('#ff8fa3', '#b8325a')
// 状态分布柱逐色渐变（与全局 CHART_COLORS 色系一致）
const STATUS_GRADS = [
  ['#5ee7ff', '#1a7fb8'], ['#7aa2ff', '#2d4fb8'], ['#ff8fa3', '#b8325a'], ['#ffd166', '#e08e00'],
  ['#ff7a9c', '#c92857'], ['#b69bff', '#5a3fb8'], ['#7ec8b8', '#2a7a68'], ['#ffa978', '#c25c2b'],
]

function render() {
  if (!pieChart || !barChart || !amountChart || !props.dashboard) return
  const d = props.dashboard

  // 1) 内/外占比（份数）——渐变扇区
  pieChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', formatter: '{b}: {c} 份 ({d}%)' },
    legend: { bottom: 0, textStyle: { color: '#8aa2b5' } },
    series: [{
      type: 'pie', radius: ['45%', '68%'], center: ['50%', '44%'],
      label: { color: '#cfe6ff' },
      data: [
        { value: d.byDirection?.['对外'] || 0, name: '对外合同', itemStyle: { color: gradIncome() } },
        { value: d.byDirection?.['对内'] || 0, name: '对内合同', itemStyle: { color: vGrad('#8ab4ff', '#2b4fc4') } },
      ],
    }],
  }, true)

  // 2) 合同状态分布——渐变柱
  const statusOrder = ['草稿', '审批中', '已驳回', '已签署', '履约中', '已完成', '已终止', '已归档']
  barChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: 36, right: 12, top: 16, bottom: 24 },
    xAxis: { type: 'category', data: statusOrder.map((s) => s.replace('已', '')), axisLabel: { color: '#8aa2b5', fontSize: 10 }, axisLine: { lineStyle: { color: '#2b4a63' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8aa2b5' }, splitLine: { lineStyle: { color: 'rgba(80,120,150,.15)' } } },
    series: [{ type: 'bar', data: statusOrder.map((s) => d.byStatus?.[s] || 0), barMaxWidth: 26,
      itemStyle: { borderRadius: [4, 4, 0, 0], color: (p) => vGrad(...STATUS_GRADS[p.dataIndex % STATUS_GRADS.length]) },
    }],
  }, true)

  // 3) 对内/对外金额对比（V1.2）——金额来自看板收支全景 overview
  const ov = d.overview || {}
  amountChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', formatter: (params) => {
      const p = params?.[0]
      return p ? `${p.name}<br/><b>¥${formatMoney(p.value, 0)}</b>` : ''
    } },
    grid: { left: 52, right: 12, top: 26, bottom: 24 },
    xAxis: { type: 'category', data: ['对外合同(收入)', '对内合同(支出)'], axisLabel: { color: '#8aa2b5', fontSize: 10 }, axisLine: { lineStyle: { color: '#2b4a63' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8aa2b5', formatter: (v) => (v / 10000) + '万' }, splitLine: { lineStyle: { color: 'rgba(80,120,150,.15)' } } },
    series: [{ type: 'bar', barMaxWidth: 56,
      data: [
        { value: Number(ov.incomeAmount || 0), itemStyle: { color: gradIncome(), borderRadius: [6, 6, 0, 0] } },
        { value: Number(ov.expenseAmount || 0), itemStyle: { color: gradExpense(), borderRadius: [6, 6, 0, 0] } },
      ],
      label: { show: true, position: 'top', color: '#cfe6ff', fontSize: 11, formatter: (p) => formatMoney(p.value, 0) },
    }],
  }, true)
}

function initCharts() {
  if (pieEl.value) pieChart = echarts.init(pieEl.value)
  if (barEl.value) barChart = echarts.init(barEl.value)
  if (amountEl.value) amountChart = echarts.init(amountEl.value)
  render()
}
function onResize() { pieChart?.resize(); barChart?.resize(); amountChart?.resize() }

onMounted(async () => { await nextTick(); initCharts(); window.addEventListener('resize', onResize) })
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  pieChart?.dispose(); barChart?.dispose(); amountChart?.dispose()
})
watch(() => props.dashboard, () => nextTick(render), { deep: true })
</script>

<template>
  <div class="charts-panel">
    <div class="chart-block"><div class="chart-title">对内 / 对外占比</div><div ref="pieEl" class="chart-canvas"></div></div>
    <div class="chart-block"><div class="chart-title">合同状态分布</div><div ref="barEl" class="chart-canvas"></div></div>
    <div class="chart-block"><div class="chart-title">对内 / 对外金额对比</div><div ref="amountEl" class="chart-canvas"></div></div>
  </div>
</template>
