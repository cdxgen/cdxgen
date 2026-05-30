<template>
  <div class="home-view">
    <h1>Welcome, {{ store.currentUser?.name ?? 'Guest' }}</h1>
    <UserList />
    <button @click="goToProfile">My Profile</button>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import axios from 'axios'
import UserList from '@/components/UserList.vue'

const router = useRouter()
const store = useUserStore()

onMounted(async () => {
  const { data } = await axios.get('/api/users')
  store.setUsers(data)
})

function goToProfile() {
  router.push({ name: 'profile', params: { id: store.currentUser?.id } })
}
</script>
