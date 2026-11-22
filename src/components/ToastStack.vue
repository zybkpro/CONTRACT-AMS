<script setup>
import { toasts } from '../utils'
</script>
<template>
  <div class="toast-stack">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.text }}</div>
  </div>
</template>
