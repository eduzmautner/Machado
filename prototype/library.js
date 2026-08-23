/* ------------------------------------------------------------------
   Machado — everything you have written.
   Title comes from a document's first line; the preview picks up where
   the title left off.
------------------------------------------------------------------- */

'use strict';

const $ = (sel) => document.querySelector(sel);

function when(iso) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: then.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

// The title is already the first line, so the preview starts after it.
function previewOf(doc) {
  const lines = Backend.plainText(doc.content).split('\n').filter((l) => l.trim());
  const rest = lines.slice(1).join(' ').trim();
  if (!rest) return '';
  return rest.length > 120 ? rest.slice(0, 120).trimEnd() + '…' : rest;
}

function render(docs) {
  const list = $('#entries');
  list.innerHTML = '';
  $('#count').textContent = docs.length
    ? `${docs.length} ${docs.length === 1 ? 'entry' : 'entries'}`
    : '';

  if (!docs.length) {
    $('#state').innerHTML =
      'Nothing here yet. <a href="index.html">Start writing →</a>';
    $('#state').hidden = false;
    return;
  }
  $('#state').hidden = true;

  for (const doc of docs) {
    const li = document.createElement('li');
    li.className = 'entry';

    const open = document.createElement('a');
    open.className = 'entry-open';
    open.href = `index.html?doc=${encodeURIComponent(doc.id)}`;

    const title = document.createElement('span');
    title.className = 'entry-title';
    title.textContent = doc.title || 'Untitled';

    const preview = document.createElement('span');
    preview.className = 'entry-preview';
    preview.textContent = previewOf(doc);

    const meta = document.createElement('span');
    meta.className = 'entry-meta';
    meta.textContent = when(doc.updated_at);

    open.append(title, preview, meta);

    // Two-step delete: the button asks before it acts, in the row itself.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'entry-delete';
    del.title = 'Delete this entry';
    del.textContent = 'Delete';

    const confirmBox = document.createElement('span');
    confirmBox.className = 'entry-confirm';
    confirmBox.hidden = true;
    confirmBox.innerHTML =
      '<span>Delete for good?</span>' +
      '<button type="button" class="danger">Delete</button>' +
      '<button type="button" class="quiet">Keep</button>';

    del.addEventListener('click', () => {
      del.hidden = true;
      confirmBox.hidden = false;
    });
    confirmBox.querySelector('.quiet').addEventListener('click', () => {
      confirmBox.hidden = true;
      del.hidden = false;
    });
    confirmBox.querySelector('.danger').addEventListener('click', async () => {
      confirmBox.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await Backend.deleteDocument(doc.id);
        li.remove();
        load();
      } catch (err) {
        confirmBox.hidden = true;
        del.hidden = false;
        $('#state').textContent = `Could not delete that entry: ${err.message}`;
        $('#state').hidden = false;
      }
    });

    li.append(open, del, confirmBox);
    list.appendChild(li);
  }
}

async function load() {
  try {
    render(await Backend.listDocuments());
  } catch (err) {
    $('#state').textContent = `Could not load your entries: ${err.message}`;
    $('#state').hidden = false;
  }
}

$('#new-entry').addEventListener('click', () => {
  location.href = 'index.html?new=1';
});

$('#sign-out').addEventListener('click', async () => {
  await Backend.signOut();
  location.replace(Backend.pageUrl('login.html'));
});

(async () => {
  if (!(await Backend.requireAuth())) return;
  load();
})();
