<template>
  <!-- Root app layout -->
  <nav class="navbar">
    <RouterLink to="/" :aria-label="homeLabel">Home</RouterLink>
    <RouterLink :to="{ name: 'about' }">About</RouterLink>
  </nav>
  <RouterView />
</template>

<script setup>
import { ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'

const homeLabel = ref('Go to home page')
</script>

<style>
.navbar { display: flex; gap: 1rem; }
</style>
