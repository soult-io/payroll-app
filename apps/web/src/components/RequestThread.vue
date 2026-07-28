<script setup lang="ts">
/**
 * Comment thread (spec 4: full comment thread; frontend spec: Timeline
 * component). Shared by the employee and admin request-detail screens.
 */
import { ref } from "vue";
import Button from "primevue/button";
import Textarea from "primevue/textarea";
import Timeline from "primevue/timeline";
import { useDates } from "../composables/useDates";
import type { ChangeRequestComment } from "../lib/api";

defineProps<{
  comments: ChangeRequestComment[];
  canComment: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{ submit: [body: string] }>();

const { dateTime } = useDates();
const draft = ref("");

function send() {
  const body = draft.value.trim();
  if (!body) return;
  emit("submit", body);
  draft.value = "";
}
</script>

<template>
  <div class="thread">
    <Timeline :value="comments" class="timeline">
      <template #content="{ item }">
        <div class="comment">
          <div class="comment-head">
            <strong>{{ item.authorName }}</strong>
            <span class="muted small">{{ dateTime(item.createdAt) }}</span>
          </div>
          <p class="comment-body">{{ item.body }}</p>
        </div>
      </template>
    </Timeline>
    <p v-if="comments.length === 0" class="muted small">No comments yet.</p>

    <form v-if="canComment" class="composer" @submit.prevent="send">
      <Textarea v-model="draft" rows="2" placeholder="Write a comment…" auto-resize class="composer-input" />
      <Button type="submit" label="Comment" size="small" :disabled="!draft.trim()" :loading="busy" />
    </form>
  </div>
</template>

<style scoped>
.thread {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.timeline {
  padding-left: 0.25rem;
}
.comment-head {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
}
.comment-body {
  margin: 0.2rem 0 0.75rem;
  white-space: pre-wrap;
}
.composer {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
}
.composer-input {
  flex: 1;
}
</style>
