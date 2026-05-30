<template>
  <div class="about-view">
    <h1>About</h1>
    <p>{{ description }}</p>
    <RouterLink to="/">Back to Home</RouterLink>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { RouterLink } from 'vue-router'

const description = ref('This is the about page of the Vue demo app.')
</script>

<style scoped>
.about-view { padding: 2rem; }
</style>
