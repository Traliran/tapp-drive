"use strict";

const $ = (id) => document.getElementById(id);

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

const state = {
    path: "",
    files: [],
    selected: new Set(),
    clipboard: { action: null, paths: [] },
    activeFile: null,
    passwords: new Map(),
    protectedFolders: [],
    sort: "name-asc",
};

let snackbarTimer = 0;
let modalResolve = null;

function icon(name, className = "icon") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#icon-${name}`);
    svg.append(use);
    return svg;
}

function showSnackbar(message) {
    const bar = $("snackbar");
    bar.textContent = message;
    bar.classList.add("show");
    window.clearTimeout(snackbarTimer);
    snackbarTimer = window.setTimeout(() => bar.classList.remove("show"), 4200);
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        let detail = response.statusText || `Request failed (${response.status})`;
        try {
            const data = await response.json();
            if (data && data.detail) detail = data.detail;
        } catch {
            // The response was not JSON.
        }
        throw new ApiError(detail, response.status);
    }
    return response;
}

async function apiJSON(url, options = {}) {
    const response = await apiFetch(url, options);
    return response.json();
}

function extension(name) {
    const index = name.lastIndexOf(".");
    if (index <= 0 || index === name.length - 1) return "";
    return name.slice(index + 1).toLowerCase();
}

function baseName(relPath) {
    const index = relPath.lastIndexOf("/");
    return index < 0 ? relPath : relPath.slice(index + 1);
}

function parentPath(relPath) {
    const index = relPath.lastIndexOf("/");
    return index < 0 ? "" : relPath.slice(0, index);
}

function dirName(relPath) {
    return parentPath(relPath);
}

function joinPath(dir, name) {
    return dir ? `${dir}/${name}` : name;
}

function isSameOrInside(path, parent) {
    if (!parent) return true;
    return path === parent || path.startsWith(`${parent}/`);
}

function protectedFolderFor(relPath) {
    let match = null;
    for (const folder of state.protectedFolders) {
        if (relPath === folder || relPath.startsWith(`${folder}/`)) {
            if (!match || folder.length > match.length) match = folder;
        }
    }
    return match;
}

function authHeaders(relPath) {
    const folder = protectedFolderFor(relPath);
    const password = folder ? state.passwords.get(folder) : null;
    return password ? { "X-Password": password } : {};
}

function passwordMap() {
    return Object.fromEntries(state.passwords);
}

function rawUrl(relPath, download = false) {
    const encoded = relPath.split("/").map(encodeURIComponent).join("/");
    let url = `${download ? "/api/download/" : "/api/raw/"}${encoded}`;
    const folder = protectedFolderFor(relPath);
    const password = folder ? state.passwords.get(folder) : null;
    if (password) url += `?password=${encodeURIComponent(password)}`;
    return url;
}

function finishModal(value) {
    const resolve = modalResolve;
    modalResolve = null;
    const modal = $("modal");
    if (modal.open) modal.close();
    if (resolve) resolve(value);
}

function openModal(options) {
    return new Promise((resolve) => {
        const modal = $("modal");
        if (modal.open) {
            const previous = modalResolve;
            modalResolve = null;
            modal.close();
            if (previous) previous(null);
        }
        modalResolve = resolve;
        $("modal-title").textContent = options.title || "";
        const message = $("modal-message");
        message.textContent = options.message || "";
        message.hidden = !options.message;
        const wrap = $("modal-field-wrap");
        wrap.hidden = !options.label;
        $("modal-label").textContent = options.label || "";
        const input = $("modal-input");
        input.type = options.type || "text";
        input.value = options.value || "";
        input.placeholder = options.placeholder || "";
        input.autocomplete = options.autocomplete || "off";
        input.spellcheck = false;
        const confirm = $("modal-confirm");
        confirm.textContent = options.confirmText || "OK";
        confirm.classList.toggle("danger", Boolean(options.danger));
        $("modal-cancel").textContent = options.cancelText || "Cancel";
        modal.showModal();
        window.setTimeout(() => {
            if (options.label) input.focus();
            else confirm.focus();
            if (options.label) input.select();
        }, 20);
    });
}

async function askPassword(folder) {
    return openModal({
        title: "Protected folder",
        message: `Enter the password for "${folder}".`,
        label: "Password",
        type: "password",
        placeholder: "Password",
        autocomplete: "current-password",
        confirmText: "Unlock",
    });
}

async function askText(options) {
    return openModal({
        title: options.title,
        message: options.message,
        label: options.label,
        value: options.value,
        placeholder: options.placeholder,
        confirmText: options.confirmText || "Create",
    });
}

async function confirmDialog(title, message, confirmText = "Delete") {
    const result = await openModal({
        title,
        message,
        confirmText,
        danger: true,
    });
    return result === true;
}

async function ensureAccess(relPath, forcePrompt = false) {
    const folder = protectedFolderFor(relPath);
    if (!folder) return true;
    if (!forcePrompt && state.passwords.has(folder)) return true;

    const password = await askPassword(folder);
    if (password === null) return false;
    try {
        await apiJSON("/api/check-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: relPath, password }),
        });
        state.passwords.set(folder, password);
        return true;
    } catch (error) {
        if (error.status === 401) {
            showSnackbar("Wrong password");
            return ensureAccess(relPath, true);
        }
        showSnackbar(error.message);
        return false;
    }
}

function formatGB(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0 GB";
    return `${number.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
}

function updateStorageInfo(info) {
    $("storage-info").textContent = `${formatGB(info.free_gb)} free of ${formatGB(info.total_gb)}`;
}

async function loadInfo() {
    try {
        const info = await apiJSON("/api/info");
        state.protectedFolders = Array.isArray(info.protected_folders) ? info.protected_folders : [];
        updateStorageInfo(info);
    } catch {
        $("storage-info").textContent = "Storage unavailable";
    }
}

function updateToolbar() {
    const hasSelection = state.selected.size > 0;
    $("btn-copy").disabled = !hasSelection;
    $("btn-cut").disabled = !hasSelection;
    $("btn-paste").disabled = state.clipboard.paths.length === 0;
}

function syncSelection() {
    document.querySelectorAll(".file-row[data-path]").forEach((row) => {
        row.classList.toggle("selected", state.selected.has(row.dataset.path));
    });
    updateToolbar();
}

function kindInfo(name, isDir, relPath) {
    if (isDir) {
        const locked = protectedFolderFor(relPath) === relPath;
        return locked
            ? { icon: "folder-lock", className: "type-locked", label: "Protected folder" }
            : { icon: "folder", className: "type-folder", label: "Folder" };
    }
    const ext = extension(name);
    if (ext === "md") return { icon: "note", className: "type-note", label: "Markdown" };
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) {
        return { icon: "image", className: "type-image", label: "Image" };
    }
    if (["mp4", "webm", "mkv", "mov", "m4v"].includes(ext)) {
        return { icon: "video", className: "type-video", label: "Video" };
    }
    if (["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)) {
        return { icon: "audio", className: "type-audio", label: "Audio" };
    }
    return { icon: "file", className: "type-file", label: "File" };
}

function renderBreadcrumbs() {
    const nav = $("breadcrumbs");
    nav.replaceChildren();

    const makeCrumb = (label, path, current) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `crumb${current ? " current" : ""}`;
        button.textContent = label;
        button.title = label;
        button.addEventListener("click", () => loadFiles(path));
        nav.append(button);
    };

    const parts = state.path.split("/").filter(Boolean);
    makeCrumb("Drive", "", parts.length === 0);
    let accumulated = "";
    for (const part of parts) {
        const separator = document.createElement("span");
        separator.className = "crumb-sep";
        separator.textContent = "/";
        nav.append(separator);
        accumulated = accumulated ? `${accumulated}/${part}` : part;
        makeCrumb(part, accumulated, accumulated === state.path);
    }
    nav.scrollLeft = nav.scrollWidth;
}

function addParentRow(parent) {
    const list = $("file-list");
    const row = document.createElement("li");
    row.className = "file-row";
    row.dataset.path = parent;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "row-main";
    const iconBox = document.createElement("span");
    iconBox.className = "file-icon type-folder";
    iconBox.append(icon("folder"));
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = "Parent folder";
    main.append(iconBox, name);
    main.addEventListener("click", () => loadFiles(parent));

    row.append(main);
    bindDropTarget(row, parent);
    list.append(row);
}

function createFileRow(file) {
    const kind = kindInfo(file.name, file.is_dir, file.rel_path);
    const row = document.createElement("li");
    row.className = "file-row";
    row.dataset.path = file.rel_path;
    if (state.selected.has(file.rel_path)) row.classList.add("selected");
    if (state.activeFile && state.activeFile.rel_path === file.rel_path) row.classList.add("active");
    row.draggable = true;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "row-main";

    const iconBox = document.createElement("span");
    iconBox.className = `file-icon ${kind.className}`;
    iconBox.append(icon(kind.icon));

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    name.title = file.name;

    main.append(iconBox, name);
    row.append(main);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "btn icon-only danger row-delete";
    deleteButton.title = `Delete ${file.name}`;
    deleteButton.setAttribute("aria-label", `Delete ${file.name}`);
    deleteButton.append(icon("trash"));
    deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteItem(file.rel_path, file.is_dir);
    });
    row.append(deleteButton);

    main.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey) {
            if (state.selected.has(file.rel_path)) state.selected.delete(file.rel_path);
            else state.selected.add(file.rel_path);
            syncSelection();
            return;
        }
        state.selected.clear();
        state.selected.add(file.rel_path);
        syncSelection();
        if (file.is_dir) {
            state.activeFile = null;
            document.body.classList.remove("view-file");
            loadFiles(file.rel_path);
        } else {
            openFile(file);
        }
    });

    row.addEventListener("dragstart", (event) => {
        if (!state.selected.has(file.rel_path)) {
            state.selected.clear();
            state.selected.add(file.rel_path);
            syncSelection();
        }
        const paths = Array.from(state.selected);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-drive-paths", JSON.stringify(paths));
        event.dataTransfer.setData("text/plain", paths.join("\n"));
    });

    if (file.is_dir) bindDropTarget(row, file.rel_path);
    return row;
}

function renderFileList() {
    const list = $("file-list");
    list.replaceChildren();

    if (state.path) addParentRow(parentPath(state.path));

    const query = $("search-input").value.trim().toLowerCase();
    const files = query
        ? state.files.filter((file) => file.name.toLowerCase().includes(query))
        : state.files;

    for (const file of files) list.append(createFileRow(file));

    if (files.length === 0) {
        const status = document.createElement("li");
        status.className = "list-status";
        status.textContent = query ? "No matches" : "This folder is empty";
        list.append(status);
    }
    updateToolbar();
}

function hasInternalDrag(event) {
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
    return types.includes("application/x-drive-paths");
}

function bindDropTarget(element, targetPath) {
    element.addEventListener("dragover", (event) => {
        const internal = hasInternalDrag(event);
        const external = event.dataTransfer
            ? Array.from(event.dataTransfer.types || []).includes("Files")
            : false;
        if (!internal && !external) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = internal ? "move" : "copy";
        element.classList.add("drag-over");
    });

    element.addEventListener("dragleave", (event) => {
        if (event.relatedTarget && element.contains(event.relatedTarget)) return;
        element.classList.remove("drag-over");
    });

    element.addEventListener("drop", async (event) => {
        const internal = hasInternalDrag(event);
        const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
        if (!internal && files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        element.classList.remove("drag-over");

        if (internal) {
            try {
                const paths = JSON.parse(event.dataTransfer.getData("application/x-drive-paths"));
                if (Array.isArray(paths) && paths.length > 0) await moveSelectedTo(paths, targetPath);
            } catch {
                showSnackbar("Could not move the selected items");
            }
        } else {
            await uploadFiles(files, targetPath);
        }
    });
}

async function loadFiles(path, clearSelection = true) {
    if (!(await ensureAccess(path))) return;

    state.path = path;
    if (clearSelection) state.selected.clear();
    updateToolbar();
    renderBreadcrumbs();
    $("file-list").innerHTML = '<li class="list-status">Loading</li>';

    try {
        const files = await apiJSON(
            `/api/list?path=${encodeURIComponent(path)}&sort=${encodeURIComponent(state.sort)}`,
            { headers: authHeaders(path) }
        );
        state.files = Array.isArray(files) ? files : [];
        renderFileList();
        document.title = path ? `${baseName(path)} · Drive` : "Drive";
    } catch (error) {
        if (error.status === 401) {
            const folder = protectedFolderFor(path);
            if (folder) {
                state.passwords.delete(folder);
                if (await ensureAccess(path, true)) {
                    await loadFiles(path, clearSelection);
                    return;
                }
            }
        }
        state.files = [];
        $("file-list").innerHTML = '<li class="list-status">Could not load this folder</li>';
        showSnackbar(error.message);
    }
}

function emptyState(title, text) {
    const wrapper = document.createElement("div");
    wrapper.className = "empty-state";
    wrapper.append(icon("drive", "empty-icon"));
    const heading = document.createElement("h3");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    wrapper.append(heading, paragraph);
    return wrapper;
}

function resetViewer() {
    state.activeFile = null;
    document.body.classList.remove("view-file");
    document.querySelectorAll(".file-row[data-path]").forEach((row) => row.classList.remove("active"));
    $("file-kind").textContent = "Preview";
    $("current-filename").textContent = "Select a file";
    $("actions").replaceChildren();
    $("content-area").replaceChildren(
        emptyState("Your files, at a glance", "Select a file from the sidebar to preview or edit it.")
    );
    document.title = state.path ? `${baseName(state.path)} · Drive` : "Drive";
}

function addAction(label, iconName, onClick = null, href = null) {
    let element;
    if (href) {
        element = document.createElement("a");
        element.href = href;
        element.download = "";
    } else {
        element = document.createElement("button");
        element.type = "button";
        element.addEventListener("click", onClick);
    }
    element.className = "btn tonal";
    element.title = label;
    element.append(icon(iconName));
    const text = document.createElement("span");
    text.textContent = label;
    element.append(text);
    $("actions").append(element);
    return element;
}

async function openFile(file) {
    if (!(await ensureAccess(file.rel_path))) return;

    state.activeFile = file;
    document.body.classList.add("view-file");
    document.querySelectorAll(".file-row[data-path]").forEach((row) => {
        row.classList.toggle("active", row.dataset.path === file.rel_path);
    });
    $("current-filename").textContent = file.name;
    $("current-filename").title = file.name;
    const kind = kindInfo(file.name, false, file.rel_path);
    $("file-kind").textContent = kind.label === "Markdown" ? "Markdown document" : kind.label;
    $("actions").replaceChildren();
    addAction("Download", "download", null, rawUrl(file.rel_path, true));
    if (extension(file.name) === "md") {
        addAction("Edit", "edit", () => toggleEdit(file));
    }

    const content = $("content-area");
    content.replaceChildren();
    content.scrollTop = 0;
    document.title = `${file.name} · Drive`;

    const ext = extension(file.name);
    try {
        if (ext === "md") {
            const response = await fetch(rawUrl(file.rel_path));
            if (!response.ok) throw new Error("Could not read the note");
            const text = await response.text();
            const article = document.createElement("article");
            article.className = "markdown-body";
            article.innerHTML = renderMarkdown(text, dirName(file.rel_path));
            content.append(article);
            return;
        }

        if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) {
            const view = document.createElement("div");
            view.className = "media-view";
            const image = document.createElement("img");
            image.src = rawUrl(file.rel_path);
            image.alt = file.name;
            image.addEventListener("error", () => showSnackbar("Could not display this image"));
            view.append(image);
            content.append(view);
            return;
        }

        if (["mp4", "webm", "mkv", "mov", "m4v"].includes(ext)) {
            const view = document.createElement("div");
            view.className = "media-view";
            const video = document.createElement("video");
            video.controls = true;
            video.preload = "metadata";
            const source = document.createElement("source");
            source.src = rawUrl(file.rel_path);
            video.append(source);
            view.append(video);
            content.append(view);
            return;
        }

        if (["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)) {
            const view = document.createElement("div");
            view.className = "audio-view";
            const mark = document.createElement("div");
            mark.className = "audio-mark";
            mark.append(icon("audio"));
            const title = document.createElement("h3");
            title.textContent = file.name;
            const audio = document.createElement("audio");
            audio.controls = true;
            audio.preload = "metadata";
            const source = document.createElement("source");
            source.src = rawUrl(file.rel_path);
            audio.append(source);
            view.append(mark, title, audio);
            content.append(view);
            return;
        }

        content.append(
            emptyState("Preview unavailable", "This file format cannot be previewed. Use Download to open it locally.")
        );
    } catch (error) {
        content.replaceChildren(emptyState("Could not open file", error.message));
        showSnackbar(error.message);
    }
}

async function toggleEdit(file) {
    if (!(await ensureAccess(file.rel_path))) return;
    try {
        const response = await fetch(rawUrl(file.rel_path));
        if (!response.ok) throw new Error("Could not read the note");
        const text = await response.text();

        $("actions").replaceChildren();
        const content = $("content-area");
        content.replaceChildren();

        const editor = document.createElement("div");
        editor.className = "editor";
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.spellcheck = false;
        textarea.setAttribute("aria-label", `Edit ${file.name}`);
        const actions = document.createElement("div");
        actions.className = "editor-actions";

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => openFile(file));

        const save = document.createElement("button");
        save.type = "button";
        save.className = "btn filled";
        save.append(icon("save"));
        const saveLabel = document.createElement("span");
        saveLabel.textContent = "Save";
        save.append(saveLabel);
        save.addEventListener("click", () => saveNote(file, textarea.value, save));

        textarea.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                saveNote(file, textarea.value, save);
            }
        });

        actions.append(cancel, save);
        editor.append(textarea, actions);
        content.append(editor);
        textarea.focus();
    } catch (error) {
        showSnackbar(error.message);
    }
}

async function saveNote(file, text, button) {
    if (!(await ensureAccess(file.rel_path))) return;
    button.disabled = true;
    try {
        await apiJSON("/api/save-text", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders(file.rel_path) },
            body: JSON.stringify({ path: file.rel_path, content: text }),
        });
        showSnackbar("Saved");
        await loadFiles(state.path, false);
        await openFile(file);
    } catch (error) {
        showSnackbar(error.message);
    } finally {
        button.disabled = false;
    }
}

function validatePlainName(name) {
    if (!name) return false;
    if (name.includes("/") || name.includes("\\")) {
        showSnackbar("Use a plain name without slashes");
        return false;
    }
    return true;
}

function noteContent(title) {
    return `# ${title}\n\nStart writing here…\n`;
}

async function createNewNote() {
    if (!(await ensureAccess(state.path))) return;
    const value = await askText({
        title: "New note",
        message: "Create a Markdown note in this folder.",
        label: "File name",
        placeholder: "untitled.md",
        confirmText: "Create",
    });
    if (value === null) return;
    const name = value.trim();
    if (!validatePlainName(name)) return;

    const fileName = /\.md$/i.test(name) ? name : `${name}.md`;
    const existing = state.files.find((file) => file.name === fileName);
    if (existing && existing.is_dir) {
        showSnackbar("A folder with that name already exists");
        return;
    }
    if (existing) {
        const replace = await confirmDialog(
            "Replace note?",
            `"${fileName}" already exists. Replace its contents?`,
            "Replace"
        );
        if (!replace) return;
    }

    const relPath = joinPath(state.path, fileName);
    if (!(await ensureAccess(relPath))) return;
    try {
        await apiJSON("/api/save-text", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders(relPath) },
            body: JSON.stringify({
                path: relPath,
                content: noteContent(fileName.replace(/\.md$/i, "")),
            }),
        });
        await loadFiles(state.path);
        await openFile({ name: fileName, rel_path: relPath, is_dir: false });
    } catch (error) {
        showSnackbar(error.message);
    }
}

async function createNewFolder() {
    if (!(await ensureAccess(state.path))) return;
    const value = await askText({
        title: "New folder",
        message: "Create a folder in this location.",
        label: "Folder name",
        placeholder: "Folder name",
        confirmText: "Create",
    });
    if (value === null) return;
    const name = value.trim();
    if (!validatePlainName(name)) return;
    if (state.files.some((file) => file.name === name)) {
        showSnackbar("An item with that name already exists");
        return;
    }

    const relPath = joinPath(state.path, name);
    if (!(await ensureAccess(relPath))) return;
    try {
        await apiJSON("/api/mkdir", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders(relPath) },
            body: JSON.stringify({ path: relPath }),
        });
        await loadFiles(state.path);
        showSnackbar("Folder created");
    } catch (error) {
        showSnackbar(error.message);
    }
}

async function deleteItem(relPath, isDir) {
    if (!(await ensureAccess(relPath))) return;
    const name = baseName(relPath);
    const confirmed = await confirmDialog(
        `Delete "${name}"?`,
        isDir
            ? "The folder and everything inside it will be permanently deleted."
            : "The file will be permanently deleted.",
        "Delete"
    );
    if (!confirmed) return;

    try {
        await apiJSON(`/api/delete?path=${encodeURIComponent(relPath)}`, {
            method: "DELETE",
            headers: authHeaders(relPath),
        });
        if (state.activeFile && isSameOrInside(state.activeFile.rel_path, relPath)) {
            resetViewer();
        }
        state.selected.delete(relPath);
        await loadFiles(state.path, false);
        await loadInfo();
        showSnackbar("Deleted");
    } catch (error) {
        showSnackbar(error.message);
    }
}

async function uploadFiles(files, targetDir = state.path) {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    if (!(await ensureAccess(targetDir))) return;

    let uploaded = 0;
    let failed = false;
    for (const file of list) {
        const form = new FormData();
        form.append("file", file, file.name || `pasted-${Date.now()}-${uploaded}.png`);
        try {
            await apiJSON(`/api/upload?path=${encodeURIComponent(targetDir)}`, {
                method: "POST",
                headers: authHeaders(targetDir),
                body: form,
            });
            uploaded += 1;
        } catch (error) {
            failed = true;
            showSnackbar(`Upload failed: ${error.message}`);
            break;
        }
    }

    await loadInfo();
    if (targetDir === state.path) await loadFiles(state.path, false);
    if (!failed) {
        const noun = uploaded === 1 ? "file" : "files";
        showSnackbar(`Uploaded ${uploaded} ${noun}`);
    }
}

async function moveSelectedTo(paths, targetDir) {
    const sources = Array.from(new Set(paths || []));
    if (sources.length === 0) return;
    if (!(await ensureAccess(targetDir))) return;
    for (const source of sources) {
        if (!(await ensureAccess(source))) return;
    }

    try {
        await apiJSON("/api/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sources,
                target_dir: targetDir,
                passwords: passwordMap(),
            }),
        });
        if (state.activeFile && sources.some((source) => isSameOrInside(state.activeFile.rel_path, source))) {
            resetViewer();
        }
        state.selected.clear();
        await loadFiles(state.path, false);
        await loadInfo();
        showSnackbar("Moved");
    } catch (error) {
        showSnackbar(error.message);
    }
}

function copySelected() {
    if (state.selected.size === 0) return;
    state.clipboard = { action: "copy", paths: Array.from(state.selected) };
    updateToolbar();
    showSnackbar(`Copied ${state.clipboard.paths.length} item(s)`);
}

function cutSelected() {
    if (state.selected.size === 0) return;
    state.clipboard = { action: "cut", paths: Array.from(state.selected) };
    updateToolbar();
    showSnackbar(`Cut ${state.clipboard.paths.length} item(s)`);
}

async function pasteBuffer() {
    if (!state.clipboard.action || state.clipboard.paths.length === 0) return;
    if (!(await ensureAccess(state.path))) return;
    for (const source of state.clipboard.paths) {
        if (!(await ensureAccess(source))) return;
    }

    const action = state.clipboard.action;
    try {
        await apiJSON(`/api/${action === "copy" ? "copy" : "move"}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sources: state.clipboard.paths,
                target_dir: state.path,
                passwords: passwordMap(),
            }),
        });
        if (
            action === "cut" &&
            state.activeFile &&
            state.clipboard.paths.some((source) => isSameOrInside(state.activeFile.rel_path, source))
        ) {
            resetViewer();
        }
        if (action === "cut") state.clipboard = { action: null, paths: [] };
        state.selected.clear();
        await loadFiles(state.path, false);
        await loadInfo();
        showSnackbar(action === "copy" ? "Pasted copy" : "Moved");
    } catch (error) {
        showSnackbar(error.message);
    }
}

function normalizeRelative(baseDir, rel) {
    const stack = baseDir ? baseDir.split("/").filter(Boolean) : [];
    for (const part of rel.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            stack.pop();
            continue;
        }
        stack.push(part);
    }
    return stack.join("/");
}

function markdownUrl(raw, baseDir) {
    const url = raw.trim();
    if (!url) return "#";
    if (/^(https?:|mailto:)/i.test(url)) return url;
    if (url.startsWith("#")) return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return "#";
    if (url.startsWith("/")) return url;
    return rawUrl(normalizeRelative(baseDir, url));
}

const HTML_ENTITIES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function formatEmphasis(html) {
    return html
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
        .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
        .replace(/_([^_\n]+)_/g, "<em>$1</em>");
}

function inlineMarkdown(text, baseDir) {
    const stash = [];
    const keep = (html) => {
        stash.push(html);
        return `\u0000${stash.length - 1}\u0000`;
    };

    let value = text;
    value = value.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
    value = value.replace(
        /!\[([^\]]*)\]\((\S+?)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)/g,
        (_, alt, src, doubleTitle, singleTitle) => {
            const title = doubleTitle ?? singleTitle ?? "";
            const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
            return keep(
                `<img src="${escapeHtml(markdownUrl(src, baseDir))}" alt="${escapeHtml(alt)}"${titleAttr}>`
            );
        }
    );
    value = value.replace(
        /\[([^\]]+)\]\((\S+?)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)/g,
        (_, label, href, doubleTitle, singleTitle) => {
            const title = doubleTitle ?? singleTitle ?? "";
            const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
            return keep(
                `<a href="${escapeHtml(markdownUrl(href, baseDir))}"${titleAttr}>${formatEmphasis(
                    escapeHtml(label)
                )}</a>`
            );
        }
    );

    value = escapeHtml(value);
    value = formatEmphasis(value);
    value = value.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)] ?? "");
    return value.replace(/\n/g, "<br>\n");
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function splitTableRow(row) {
    let value = row.trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    return value.split("|").map((cell) => cell.trim());
}

function isBlockStart(line) {
    return (
        !line.trim() ||
        /^```/.test(line) ||
        /^#{1,6}\s+/.test(line) ||
        /^\s*[-*+]\s+/.test(line) ||
        /^\s*\d+[.)]\s+/.test(line) ||
        /^>\s?/.test(line) ||
        /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)
    );
}

function renderMarkdown(markdown, baseDir = "") {
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
            index += 1;
            continue;
        }

        const fence = line.match(/^```([\w+-]*)\s*$/);
        if (fence) {
            index += 1;
            const code = [];
            while (index < lines.length && !/^```\s*$/.test(lines[index])) {
                code.push(lines[index]);
                index += 1;
            }
            if (index < lines.length) index += 1;
            const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
            output.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            const level = heading[1].length;
            output.push(`<h${level}>${inlineMarkdown(heading[2], baseDir)}</h${level}>`);
            index += 1;
            continue;
        }

        if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
            output.push("<hr>");
            index += 1;
            continue;
        }

        if (/^>\s?/.test(line)) {
            const quote = [];
            while (index < lines.length && /^>\s?/.test(lines[index])) {
                quote.push(lines[index].replace(/^>\s?/, ""));
                index += 1;
            }
            output.push(`<blockquote>${renderMarkdown(quote.join("\n"), baseDir)}</blockquote>`);
            continue;
        }

        if (/^\s*[-*+]\s+/.test(line)) {
            const items = [];
            while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
                items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
                index += 1;
            }
            output.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item, baseDir)}</li>`).join("")}</ul>`);
            continue;
        }

        if (/^\s*\d+[.)]\s+/.test(line)) {
            const items = [];
            while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
                items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
                index += 1;
            }
            output.push(`<ol>${items.map((item) => `<li>${inlineMarkdown(item, baseDir)}</li>`).join("")}</ol>`);
            continue;
        }

        if (
            line.includes("|") &&
            index + 1 < lines.length &&
            TABLE_SEPARATOR.test(lines[index + 1])
        ) {
            const headers = splitTableRow(line);
            index += 2;
            const rows = [];
            while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
                rows.push(splitTableRow(lines[index]));
                index += 1;
            }
            const head = headers
                .map((header) => `<th>${inlineMarkdown(header, baseDir)}</th>`)
                .join("");
            const body = rows
                .map(
                    (row) =>
                        `<tr>${headers
                            .map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || "", baseDir)}</td>`)
                            .join("")}</tr>`
                )
                .join("");
            output.push(
                `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
            );
            continue;
        }

        const paragraph = [];
        while (index < lines.length && !isBlockStart(lines[index])) {
            const isTable =
                lines[index].includes("|") &&
                index + 1 < lines.length &&
                TABLE_SEPARATOR.test(lines[index + 1]);
            if (isTable) break;
            paragraph.push(lines[index].trim());
            index += 1;
        }
        if (paragraph.length > 0) {
            output.push(`<p>${inlineMarkdown(paragraph.join("\n"), baseDir)}</p>`);
        }
    }

    return output.join("\n");
}

function bindEvents() {
    $("btn-new-note").addEventListener("click", createNewNote);
    $("btn-new-folder").addEventListener("click", createNewFolder);
    $("btn-upload").addEventListener("click", () => $("file-input").click());
    $("file-input").addEventListener("change", async (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        await uploadFiles(files, state.path);
    });

    $("btn-copy").addEventListener("click", copySelected);
    $("btn-cut").addEventListener("click", cutSelected);
    $("btn-paste").addEventListener("click", pasteBuffer);
    $("btn-refresh").addEventListener("click", async () => {
        await loadInfo();
        await loadFiles(state.path, false);
    });
    $("btn-back").addEventListener("click", () => document.body.classList.remove("view-file"));

    $("search-input").addEventListener("input", renderFileList);
    $("sort-select").addEventListener("change", async (event) => {
        state.sort = event.target.value;
        await loadFiles(state.path, false);
    });

    const dropzone = $("dropzone");
    dropzone.addEventListener("click", () => $("file-input").click());
    dropzone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            $("file-input").click();
        }
    });
    dropzone.addEventListener("dragover", (event) => {
        const external = event.dataTransfer
            ? Array.from(event.dataTransfer.types || []).includes("Files")
            : false;
        if (!hasInternalDrag(event) && !external) return;
        event.preventDefault();
        dropzone.classList.add("hover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("hover"));
    dropzone.addEventListener("drop", async (event) => {
        const internal = hasInternalDrag(event);
        const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
        if (!internal && files.length === 0) return;
        event.preventDefault();
        dropzone.classList.remove("hover");
        if (internal) {
            try {
                const paths = JSON.parse(event.dataTransfer.getData("application/x-drive-paths"));
                if (Array.isArray(paths) && paths.length > 0) await moveSelectedTo(paths, state.path);
            } catch {
                showSnackbar("Could not move the selected items");
            }
        } else {
            await uploadFiles(files, state.path);
        }
    });

    window.addEventListener("paste", async (event) => {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || $("modal").open) return;
        const files = [];
        for (const item of event.clipboardData?.items || []) {
            if (item.kind === "file") {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length > 0) {
            event.preventDefault();
            await uploadFiles(files, state.path);
        }
    });

    window.addEventListener("keydown", (event) => {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if ($("modal").open) return;
        if (!(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === "c") {
            event.preventDefault();
            copySelected();
        } else if (key === "x") {
            event.preventDefault();
            cutSelected();
        } else if (key === "v") {
            event.preventDefault();
            pasteBuffer();
        }
    });

    $("modal-cancel").addEventListener("click", () => finishModal(null));
    $("modal").addEventListener("cancel", (event) => {
        event.preventDefault();
        finishModal(null);
    });
    $("modal-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const wrap = $("modal-field-wrap");
        if (wrap.hidden) {
            finishModal(true);
            return;
        }
        const value = $("modal-input").value;
        if (!value.trim()) {
            $("modal-input").focus();
            return;
        }
        finishModal(value);
    });
}

async function init() {
    state.sort = $("sort-select").value;
    bindEvents();
    resetViewer();
    await loadInfo();
    await loadFiles("");
    updateToolbar();
}

init();
