<script setup lang="ts">
/**
 * Admin user-management stub (step 2): invite, reset, unlock over the real
 * API. Full admin screens land in step 5.
 */
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Message from "primevue/message";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import { authClient } from "../lib/auth-client";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role?: string | undefined;
  banned?: boolean | null | undefined;
  banReason?: string | null | undefined;
}

const users = ref<AdminUser[]>([]);
const inviteName = ref("");
const inviteEmail = ref("");
const inviteRole = ref<"admin" | "employee">("employee");
const busy = ref(false);
const notice = ref("");
const error = ref("");
const setupLink = ref("");

async function load() {
  const { data } = await authClient.admin.listUsers({ query: { limit: 100 } });
  users.value = ((data as { users?: AdminUser[] } | undefined)?.users ?? []) as AdminUser[];
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

async function invite() {
  error.value = "";
  notice.value = "";
  setupLink.value = "";
  busy.value = true;
  try {
    const res = await post("/api/admin/users", {
      name: inviteName.value,
      email: inviteEmail.value,
      role: inviteRole.value,
    });
    if (res.status === 409) {
      error.value = "A user with that email already exists.";
      return;
    }
    if (!res.ok) {
      error.value = "Invite failed.";
      return;
    }
    const data = (await res.json()) as { setupLink: string; smtpMissing: boolean };
    notice.value = data.smtpMissing
      ? "Invited. SMTP is not configured — copy the setup link below manually."
      : "Invited — setup email queued.";
    setupLink.value = data.setupLink;
    inviteName.value = "";
    inviteEmail.value = "";
    await load();
  } finally {
    busy.value = false;
  }
}

async function reset(u: AdminUser) {
  error.value = "";
  setupLink.value = "";
  const res = await post(`/api/admin/users/${u.id}/reset`, {});
  if (!res.ok) {
    error.value = `Reset failed for ${u.email}.`;
    return;
  }
  const data = (await res.json()) as { setupLink: string };
  notice.value = `Reset link issued for ${u.email} — they must re-enroll.`;
  setupLink.value = data.setupLink;
  await load();
}

async function unlock(u: AdminUser) {
  error.value = "";
  const res = await post(`/api/admin/users/${u.id}/unlock`, {});
  notice.value = res.ok ? `${u.email} unlocked.` : "";
  error.value = res.ok ? "" : `Unlock failed for ${u.email}.`;
  await load();
}

function statusOf(u: AdminUser): string {
  if (!u.banned) return "active";
  return u.banReason === "pending_enrollment" ? "pending enrollment" : `disabled (${u.banReason ?? "banned"})`;
}

onMounted(load);
</script>

<template>
  <section class="admin">
    <h2>User management</h2>

    <form class="invite" @submit.prevent="invite">
      <h3>Invite user</h3>
      <InputText v-model="inviteName" placeholder="Full name" required />
      <InputText v-model="inviteEmail" type="email" placeholder="Email" required />
      <Select
        v-model="inviteRole"
        :options="['employee', 'admin']"
        placeholder="Role"
      />
      <Button type="submit" label="Send invite" :loading="busy" />
    </form>

    <Message v-if="notice" severity="success" :closable="false">{{ notice }}</Message>
    <div v-if="setupLink" class="setup-link">
      <code>{{ setupLink }}</code>
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <DataTable :value="users" striped-rows>
      <Column field="name" header="Name" />
      <Column field="email" header="Email" />
      <Column field="role" header="Role" />
      <Column header="Status">
        <template #body="{ data }">{{ statusOf(data) }}</template>
      </Column>
      <Column header="Actions">
        <template #body="{ data }">
          <div class="row-actions">
            <Button label="Reset" size="small" text @click="reset(data)" />
            <Button
              v-if="data.banned && data.banReason === 'lockout'"
              label="Unlock"
              size="small"
              text
              @click="unlock(data)"
            />
          </div>
        </template>
      </Column>
    </DataTable>
  </section>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.invite {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.invite h3 {
  width: 100%;
  margin: 0;
}
.setup-link {
  padding: 0.5rem;
  background: #f4f4f4;
  border-radius: 6px;
  word-break: break-all;
}
.row-actions {
  display: flex;
  gap: 0.25rem;
}
</style>
