import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

export const useUserStore = defineStore('user', () => {
  const users = ref([])
  const currentUser = ref(null)

  const activeUsers = computed(() => users.value.filter((u) => u.active))

  function setUsers(list) {
    users.value = list
  }

  function updateUser(updated) {
    const idx = users.value.findIndex((u) => u.id === updated.id)
    if (idx !== -1) users.value[idx] = { ...users.value[idx], ...updated }
  }

  function removeUser(id) {
    users.value = users.value.filter((u) => u.id !== id)
  }

  async function fetchCurrentUser(id) {
    const { data } = await axios.get(`/api/users/${id}`)
    currentUser.value = data
  }

  return { users, currentUser, activeUsers, setUsers, updateUser, removeUser, fetchCurrentUser }
})
