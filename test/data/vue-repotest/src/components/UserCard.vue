<template>
  <div :class="['card', { active: isActive }]">
    <h3>{{ userName }}</h3>
    <p>{{ userEmail }}</p>
    <button @click="$emit('delete')">Delete</button>
    <input v-model="editName" @blur="emitUpdate" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  userName: string
  userEmail: string
  isActive: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: { name: string }]
  delete: []
}>()

const editName = ref(props.userName)

watch(() => props.userName, (newVal) => {
  editName.value = newVal
})

function emitUpdate() {
  emit('update:modelValue', { name: editName.value })
}
</script>
