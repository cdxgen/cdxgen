<template>
  <!-- UserList: renders a list of user cards -->
  <div class="user-list">
    <UserCard
      v-for="user in users"
      :key="user.id"
      :user-name="user.name"
      :user-email="user.email"
      :is-active="user.active"
      @update:model-value="onUserUpdate"
      @delete="onUserDelete(user.id)"
    />
    <component :is="emptyState" v-if="!users.length" />
    <Teleport to="body">
      <ConfirmDialog
        v-model:visible="showConfirm"
        :title="confirmTitle"
        @confirm="doDelete"
      />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useUserStore } from '@/stores/user'
import { storeToRefs } from 'pinia'
import axios from 'axios'
import UserCard from './UserCard.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const store = useUserStore()
const { users } = storeToRefs(store)

const showConfirm = ref(false)
const confirmTitle = ref('')
const emptyState = ref('p')

const pendingDeleteId = ref<number | null>(null)

function onUserUpdate(updatedUser: { id: number; name: string }) {
  store.updateUser(updatedUser)
}

function onUserDelete(id: number) {
  pendingDeleteId.value = id
  confirmTitle.value = 'Are you sure?'
  showConfirm.value = true
}

async function doDelete() {
  if (pendingDeleteId.value !== null) {
    await axios.delete(`/api/users/${pendingDeleteId.value}`)
    store.removeUser(pendingDeleteId.value)
  }
  showConfirm.value = false
}
</script>

<style scoped>
.user-list { display: grid; gap: 1rem; }
</style>
