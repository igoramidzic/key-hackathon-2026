import { escapeHtml, formatTime, icon } from '../utils';
import type { AppState, ViewApi, ChatMessage } from '../../types';

let draft = '';
let sending = false;
let lastRoom = '';
let lastMessageCount = 0;
let followMessages = true;

const e = (value: unknown) => escapeHtml(String(value ?? ''));
const initials = (name: string) =>
  String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
const tone = (name: string) => [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5;
function safeHref(href: string) {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')
    ? href
    : '/teams';
}
function messageText(text: string) {
  return e(text)
    .split('\n')
    .map((line) => {
      const formatted = line
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
      if (!line.trim()) return '';
      const heading = line.length < 32 && !/[.:!?]$/.test(line.trim());
      return heading ? `<p class="t-card-heading">${formatted}</p>` : `<p>${formatted}</p>`;
    })
    .join('');
}
function messageView(message: ChatMessage) {
  if (message.role === 'system')
    return `<div class="t-system">${icon('users', 14)}<span>${e(message.text)}</span></div>`;
  const agent = message.role === 'agent';
  const mine = message.author === 'You';
  const links = message.links?.length
    ? `<div class="t-actions">${message.links.map((link) => `<a href="${e(safeHref(link.href))}">${e(link.label)}</a>`).join('')}</div>`
    : '';
  const card = agent && (message.kind || message.links?.length);
  if (mine)
    return `<article class="t-msg t-mine"><div class="t-meta"><time>${e(formatTime(message.timestamp))}</time></div><div class="t-bubble">${messageText(message.text)}</div></article>`;
  return `<article class="t-msg" data-message="${e(message.id)}"><span class="t-av ${agent ? 't-av-bot' : `t-av-${tone(message.author)}`}">${agent ? icon('bolt', 15) : e(initials(message.author))}</span><div class="t-body"><div class="t-meta"><strong>${e(message.author)}</strong><time>${e(formatTime(message.timestamp))}</time></div><div class="t-bubble ${card ? 't-card' : ''}">${messageText(message.text)}${links}</div></div></article>`;
}
function getIncident(state: AppState) {
  return state.simulation.phase === 'injecting' ? undefined : state.incidents?.[0];
}
function isRoomReady(state: AppState): boolean {
  return (
    Boolean(getIncident(state)) &&
    ['collaborating', 'analyzing', 'resolved'].includes(state.simulation.phase)
  );
}
export function renderTeams(state: AppState, query = new URLSearchParams()): string {
  void query;
  const incident = getIncident(state);
  const roomReady = isRoomReady(state);
  const appId = incident?.appId || state.simulation.targetAppId || 'checkout-api';
  const messages = state.messages || [];
  const resolved = state.simulation.phase === 'resolved';
  const canRecover = state.simulation.phase === 'analyzing';
  const participants = incident?.participants || [];
  const id = incident?.id || '';
  if (id !== lastRoom) {
    lastRoom = id;
    lastMessageCount = 0;
    followMessages = true;
    draft = '';
  }
  const title = `${id} · ${appId}`;
  const last = messages.at(-1);
  const room = roomReady
    ? `<a href="/teams" class="t-chat-item active"><span class="t-av t-av-group">${icon('users', 15)}</span><span class="t-chat-text"><span class="t-chat-row"><strong>${e(title)}</strong><time>${e(formatTime(last?.timestamp))}</time></span><span class="t-preview">${e(last ? `${last.author === 'You' ? 'You' : last.author.split(' ')[0]}: ${last.text.split('\n')[0]}` : '')}</span></span></a>`
    : '';
  const others = [
    ['Platform SRE', 'Priya: Thanks, will take a look after standup', '09:12'],
    ['Jordan Lee', 'Sounds good 👍', 'Yesterday'],
  ]
    .map(
      ([name, text, time]) =>
        `<div class="t-chat-item"><span class="t-av t-av-${tone(name)}">${e(initials(name))}</span><span class="t-chat-text"><span class="t-chat-row"><span>${e(name)}</span><time>${time}</time></span><span class="t-preview">${e(text)}</span></span></div>`,
    )
    .join('');
  const conversation = roomReady
    ? `<header class="t-chat-head"><span class="t-av t-av-group">${icon('users', 15)}</span><h2>${e(title)}</h2><nav class="t-tabs"><span class="active">Chat</span><span>Files</span></nav><span class="t-head-right">${resolved ? '<span class="t-resolved">Resolved</span>' : canRecover ? `<button type="button" class="t-btn" data-resolve>Simulate recovery</button>` : ''}<span class="t-people" title="${e(participants.map((p) => p.name).join(', '))}">${icon('users', 16)} ${participants.length + 1}</span></span></header>
      <div class="t-scroll" id="t-scroll" data-preserve-scroll>${messages.map(messageView).join('')}${resolved ? '<div class="t-system">Incident resolved</div>' : ''}</div>
      <div class="t-compose">${resolved ? '' : `<div class="t-suggest">${['Who owns this service?', 'Show evidence', 'What is the safest mitigation?'].map((prompt) => `<button type="button" data-prompt="${e(prompt)}" ${sending ? 'disabled' : ''}>${e(prompt)}</button>`).join('')}</div>`}<form class="t-box"><textarea id="teams-message-input" name="message" rows="1" aria-label="Type a message" placeholder="Type a message" maxlength="4000" ${sending ? 'disabled' : ''}>${e(draft)}</textarea><button class="t-send" type="submit" aria-label="Send" ${sending ? 'disabled' : ''}>${icon('send', 18)}</button></form></div>`
    : `<div class="t-blank">${
        incident || state.simulation.phase === 'injecting'
          ? '<p>Waiting for the incident chat to be created…</p>'
          : '<p>No incident chat yet.</p><button type="button" class="t-btn" data-trigger-incident>Start demo incident</button>'
      }</div>`;
  return `<div class="tm">
    <header class="t-top"><span class="t-top-dots">${icon('grid', 16)}</span><span class="t-search">${icon('search', 14)} Search</span><span class="avatar t-me">AM</span></header>
    <div class="t-main">
      <nav class="t-rail"><span>${icon('bell', 20)}<small>Activity</small></span><a href="/teams" class="active">${icon('chat', 20)}<small>Chat</small></a><span>${icon('users', 20)}<small>Teams</small></span><span>${icon('calendar', 20)}<small>Calendar</small></span></nav>
      <aside class="t-list"><div class="t-list-head"><h2>Chat</h2></div><div class="t-list-label">Recent</div>${room}${others}</aside>
      <section class="t-conv">${conversation}</section>
    </div>
  </div>`;
}
export function bindTeams(container: HTMLElement, state: AppState, api: ViewApi): void {
  const scroll = container.querySelector<HTMLElement>('.t-scroll');
  const count = state.messages?.length || 0;
  if (scroll) {
    if (followMessages && count !== lastMessageCount) scroll.scrollTop = scroll.scrollHeight;
    scroll.addEventListener(
      'scroll',
      () => {
        followMessages = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
      },
      { passive: true },
    );
  }
  lastMessageCount = count;
  const textarea = container.querySelector<HTMLTextAreaElement>('#teams-message-input');
  textarea?.addEventListener('input', () => {
    draft = textarea.value;
  });
  async function send(text: string): Promise<void> {
    const value = text.trim();
    if (!value || sending || !isRoomReady(state)) return;
    sending = true;
    if (textarea) textarea.disabled = true;
    try {
      await api.sendMessage(value);
      draft = '';
      followMessages = true;
      if (textarea) textarea.value = '';
    } catch (error) {
      api.toast(error instanceof Error ? error.message : 'Could not send the message. Try again.');
    } finally {
      sending = false;
      if (textarea) textarea.disabled = false;
      void api.refresh();
    }
  }
  container.querySelector('.t-box')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void send(textarea?.value || draft);
  });
  textarea?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send(textarea.value);
    }
  });
  container
    .querySelectorAll<HTMLButtonElement>('[data-prompt]')
    .forEach((button) =>
      button.addEventListener('click', () => void send(button.dataset.prompt || '')),
    );
  container
    .querySelector('[data-trigger-incident]')
    ?.addEventListener('click', () => api.control({ action: 'inject' }));
  container.querySelectorAll<HTMLButtonElement>('[data-resolve]').forEach((button) =>
    button.addEventListener('click', () => {
      if (state.simulation.phase === 'analyzing') void api.control({ action: 'resolve' });
    }),
  );
}
