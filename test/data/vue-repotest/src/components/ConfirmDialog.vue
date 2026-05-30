<template>
  <div v-if="visible" class="dialog-overlay">
    <div class="dialog">
      <h2>{{ title }}</h2>
      <div class="actions">
        <button @click="$emit('confirm')">Confirm</button>
        <button @click="$emit('update:visible', false)">Cancel</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean
  title: string
}>()

defineEmits<{
  confirm: []
  'update:visible': [value: boolean]
}>()
</script>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}
.dialog { background: #fff; padding: 2rem; border-radius: 8px; }
.actions { display: flex; gap: 1rem; margin-top: 1rem; }
</style>
