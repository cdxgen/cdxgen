<template>
  <div class="profile-view">
    <h1>Profile</h1>
    <div v-if="user">
      <p>Name: {{ user.name }}</p>
      <p>Email: {{ user.email }}</p>
    </div>
    <div v-else>Loading...</div>
    <RouterLink to="/">Back to Home</RouterLink>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const store = useUserStore()

const user = computed(() =>
  store.users.find((u) => String(u.id) === String(route.params.id))
)
</script>

<style scoped>
.profile-view { padding: 2rem; }
</style>
