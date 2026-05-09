/**
 * LÓGICA DO FRONTEND - BIBLIOTECA PRO
 * Inclui compressão inteligente de imagens para evitar sobrecarga no servidor.
 */

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz1VqNXy1Yd1fj2pIWzq6UlxCJ0ot2UU06TopeZz-epDU4YnPbaE8QRNf47HmtefKCZ/exec'; // <-- COLOQUE SUA URL AQUI

let livrosData = [];
let html5QrCode = null;
let streamCamera = null;

// --- SISTEMA DE FILA ---
let filaDeSincronizacao = [];
let isProcessandoFila = false;

document.addEventListener('DOMContentLoaded', () => {
    configurarEventos();
    carregarLivros(); // Carrega do Google apenas 1x ao abrir
    criarIndicadorSync(); // Cria a UI da fila no canto da tela
});

function configurarEventos() {
    document.getElementById('formLivro').onsubmit = salvarLivro;
    document.getElementById('pesquisa').oninput = (e) => renderizarLivros(e.target.value);
    
    document.getElementById('btnScan').onclick = abrirScanner;
    document.getElementById('btnAbrirCameraForm').onclick = abrirCamera;
    document.getElementById('btnCapturarFoto').onclick = capturarFoto;
    document.getElementById('btnLimpar').onclick = limparFormulario;
    document.getElementById('btnGerarCodigo').onclick = gerarCodigoAleatorio;
    document.getElementById('btnRemoverCapa').onclick = () => atualizarPreviewCapa(null);

    document.getElementById('inputArquivo').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const larguraAlvo = 400; 
                const escala = larguraAlvo / img.width;
                canvas.width = larguraAlvo;
                canvas.height = img.height * escala;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                atualizarPreviewCapa(canvas.toDataURL('image/jpeg', 0.6));
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    };
}

function gerarCodigoAleatorio() {
    const num = Math.floor(Math.random() * 1000000);
    document.getElementById('codigo').value = "LIB" + num.toString().padStart(6, '0');
}

async function carregarLivros() {
    const container = document.getElementById('containerLivros');
    container.innerHTML = `<div class="flex flex-col items-center py-20 text-slate-400"><i class="fa-solid fa-circle-notch fa-spin text-3xl mb-4"></i> Conectando ao Acervo...</div>`;
    
    try {
        const res = await fetch(`${GOOGLE_SCRIPT_URL}?action=list&t=${Date.now()}`);
        livrosData = await res.json();
        renderizarLivros();
    } catch (e) {
        container.innerHTML = `<p class="text-center text-red-500 py-20">Erro ao carregar o banco de dados.</p>`;
    }
}

// ==========================================
// SALVAR: ADICIONA À FILA E LIBERA O USUÁRIO
// ==========================================
function salvarLivro(e) {
    e.preventDefault();

    const idExistente = document.getElementById('livroId').value;
    const isNovo = !idExistente;
    
    // Se for novo, geramos um ID falso apenas para a interface visual
    const tempId = isNovo ? "temp_" + Date.now() : idExistente;
    const itemExistente = livrosData.find(l => String(l.id) === String(idExistente));

    const payload = {
        action: "save",
        id: isNovo ? null : idExistente, // Null para o Google criar um ID real
        codigo_barra: document.getElementById('codigo').value,
        isbn: document.getElementById('isbn').value,
        titulo: document.getElementById('titulo').value,
        autor: document.getElementById('autor').value,
        quantidade: document.getElementById('quantidade').value,
        genero: document.getElementById('genero').value,
        local: document.getElementById('local').value,
        ano: document.getElementById('ano').value,
        editora: document.getElementById('editora').value,
        capa: document.getElementById('capaBase64').value,
        drive_id: itemExistente ? itemExistente.drive_id : ""
    };

    // 1. Atualiza a lista na memória INSTANTANEAMENTE
    const livroAtualizado = {
        ...payload,
        id: tempId,
        capa: payload.capa && payload.capa.startsWith('data:') ? payload.capa : (itemExistente ? itemExistente.capa : "")
    };

    if (idExistente) {
        const index = livrosData.findIndex(l => String(l.id) === String(idExistente));
        if (index !== -1) livrosData[index] = livroAtualizado;
    } else {
        livrosData.push(livroAtualizado);
    }

    // 2. Redesenha a tela e limpa o form na mesma fração de segundo
    renderizarLivros(document.getElementById('pesquisa').value);
    limparFormulario();

    // 3. Manda para a Fila de Sincronização
    filaDeSincronizacao.push({
        tipo: 'save',
        tempId: tempId,
        payload: payload
    });

    // 4. Inicia o processamento da fila por trás
    processarFila();
}

// ==========================================
// EXCLUIR: ADICIONA À FILA
// ==========================================
function excluirLivro(id) {
    if (String(id).startsWith('temp_')) {
        alert("Este livro ainda está a ser sincronizado. Aguarde uns segundos.");
        return;
    }

    if (!confirm("Confirmar exclusão?")) return;
    
    fecharModal('modalDetalhes');
    
    // Atualiza a tela na hora
    livrosData = livrosData.filter(l => String(l.id) !== String(id));
    renderizarLivros(document.getElementById('pesquisa').value);
    
    // Manda para a fila
    filaDeSincronizacao.push({ tipo: 'delete', payload: { action: 'delete', id: id } });
    processarFila();
}

// ==========================================
// O MOTOR DA FILA (BACKGROUND SYNC)
// ==========================================
async function processarFila() {
    // Se já estiver rodando ou a fila estiver vazia, não faz nada
    if (isProcessandoFila || filaDeSincronizacao.length === 0) return;
    
    isProcessandoFila = true;
    atualizarIndicadorSync();

    while (filaDeSincronizacao.length > 0) {
        const item = filaDeSincronizacao[0]; // Pega o primeiro da fila

        try {
            const resp = await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify(item.payload)
            });
            const resultado = await resp.json();

            // Sucesso! Remove da fila
            if (resultado.status === "success" || resultado.status === "deleted") {
                // Se foi um salvamento de livro NOVO, trocamos o ID temporário pelo ID real que o Google gerou
                if (item.tipo === 'save' && !item.payload.id) {
                    const idx = livrosData.findIndex(l => String(l.id) === String(item.tempId));
                    if (idx !== -1) livrosData[idx].id = resultado.id;
                }
                filaDeSincronizacao.shift(); // Tira da fila
            } else {
                console.error("Erro do Google:", resultado);
                filaDeSincronizacao.shift(); // Tira da fila mesmo com erro para não travar o app
            }
        } catch (e) {
            console.error("Sem internet ou erro de conexão. Tentando novamente mais tarde...");
            break; // Interrompe o loop. O usuário terá que tentar de novo (ou quando clicar em salvar de novo a fila recomeça)
        }
        
        atualizarIndicadorSync();
    }

    isProcessandoFila = false;
    atualizarIndicadorSync();
}

// ==========================================
// INDICADOR VISUAL DA FILA (O AVISO FLUTUANTE)
// ==========================================
function criarIndicadorSync() {
    const div = document.createElement('div');
    div.id = 'indicadorSync';
    div.className = 'fixed bottom-6 right-6 bg-slate-800 text-white px-5 py-3 rounded-full shadow-2xl text-sm font-bold flex items-center gap-3 z-50 transition-all duration-500 opacity-0 translate-y-10 pointer-events-none';
    document.body.appendChild(div);
}

function atualizarIndicadorSync() {
    const ind = document.getElementById('indicadorSync');
    if (!ind) return;

    if (filaDeSincronizacao.length > 0) {
        ind.innerHTML = `<i class="fa-solid fa-cloud-arrow-up fa-fade text-blue-400 text-lg"></i> <span>Sincronizando ${filaDeSincronizacao.length} item(ns)...</span>`;
        ind.classList.remove('opacity-0', 'translate-y-10');
        ind.classList.add('opacity-100', 'translate-y-0');
    } else {
        ind.innerHTML = `<i class="fa-solid fa-check text-green-400 text-lg"></i> <span>Tudo guardado no Google!</span>`;
        
        // Esconde depois de 2 segundos
        setTimeout(() => {
            if (filaDeSincronizacao.length === 0) {
                ind.classList.remove('opacity-100', 'translate-y-0');
                ind.classList.add('opacity-0', 'translate-y-10');
            }
        }, 2500);
    }
}

// ==========================================
// INTERFACE E RENDERIZAÇÃO
// ==========================================
function renderizarLivros(filtro = "") {
    const container = document.getElementById('containerLivros');
    container.innerHTML = "";
    const termo = filtro.toLowerCase();

    const filtrados = livrosData.filter(l => 
        l.titulo.toLowerCase().includes(termo) || 
        l.autor.toLowerCase().includes(termo) ||
        l.codigo_barra.toLowerCase().includes(termo)
    );

    if (filtrados.length === 0) {
        container.innerHTML = `<p class="text-center text-slate-400 py-20">Nenhum livro encontrado.</p>`;
        return;
    }

    const grid = document.createElement('div');
    grid.className = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6";

    filtrados.forEach(livro => {
        const card = document.createElement('div');
        card.className = "bg-white p-4 rounded-2xl shadow-sm border border-slate-200 cursor-pointer hover:shadow-md transition-all flex gap-4 relative overflow-hidden";
        card.onclick = () => abrirDetalhes(livro);
        
        const capaUrl = livro.capa || 'https://via.placeholder.com/150x200?text=SEM+FOTO';
        
        // Se estiver com ID temporário, mostramos um pequeno ícone de relógio no canto da foto
        const isSincronizando = String(livro.id).startsWith('temp_');
        const badgeSync = isSincronizando ? `<div class="absolute top-2 left-2 bg-blue-500 text-white w-5 h-5 flex items-center justify-center rounded-full shadow"><i class="fa-solid fa-clock fa-spin text-[10px]"></i></div>` : '';

        card.innerHTML = `
            <div class="relative">
                <img src="${capaUrl}" class="w-16 h-20 object-cover rounded-lg shadow-sm" onerror="this.src='https://via.placeholder.com/150x200?text=?'">
                ${badgeSync}
            </div>
            <div class="flex-1 min-w-0">
                <h4 class="font-bold text-slate-800 text-sm truncate">${livro.titulo}</h4>
                <p class="text-xs text-slate-500 truncate">${livro.autor}</p>
                <span class="inline-block mt-2 px-2 py-0.5 bg-blue-50 text-blue-600 rounded text-[10px] font-bold uppercase tracking-tighter">${livro.codigo_barra}</span>
            </div>
        `;
        grid.appendChild(card);
    });
    container.appendChild(grid);
}

function abrirDetalhes(livro) {
    const isSincronizando = String(livro.id).startsWith('temp_');
    const conteudo = document.getElementById('detalhesConteudo');
    const capaUrl = livro.capa || 'https://via.placeholder.com/300x400?text=SEM+IMAGEM';

    conteudo.innerHTML = `
        <div class="flex flex-col sm:flex-row gap-6">
            <img src="${capaUrl}" class="w-32 h-44 object-cover rounded-xl shadow-lg mx-auto sm:mx-0" onerror="this.src='https://via.placeholder.com/300x400?text=?'">
            <div class="flex-1">
                ${isSincronizando ? '<span class="bg-blue-100 text-blue-700 text-[10px] px-2 py-1 rounded-full font-bold uppercase mb-2 inline-block"><i class="fa-solid fa-cloud-arrow-up"></i> Aguardando Servidor</span>' : ''}
                <h3 class="text-2xl font-bold text-slate-800 leading-tight mb-1">${livro.titulo}</h3>
                <p class="text-blue-600 font-semibold mb-4 text-lg">${livro.autor}</p>
                
                <div class="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
                    <div><span class="block text-slate-400 text-[10px] uppercase font-bold">Código</span><p class="font-mono">${livro.codigo_barra}</p></div>
                    <div><span class="block text-slate-400 text-[10px] uppercase font-bold">Estoque</span><p>${livro.quantidade} un.</p></div>
                </div>
            </div>
        </div>
    `;

    // Proteção: não deixa editar ou excluir se ainda estiver a subir para o Google
    const btnEditar = document.getElementById('btnEditarFicha');
    const btnExcluir = document.getElementById('btnExcluirFicha');
    
    if (isSincronizando) {
        btnEditar.onclick = () => alert("Aguarde a sincronização terminar para editar.");
        btnExcluir.onclick = () => alert("Aguarde a sincronização terminar para excluir.");
        btnEditar.classList.add('opacity-50');
        btnExcluir.classList.add('opacity-50');
    } else {
        btnEditar.onclick = () => { preencherFormulario(livro); fecharModal('modalDetalhes'); };
        btnExcluir.onclick = () => excluirLivro(livro.id);
        btnEditar.classList.remove('opacity-50');
        btnExcluir.classList.remove('opacity-50');
    }

    document.getElementById('modalDetalhes').classList.add('active');
}

// ==========================================
// CÂMERA, SCANNER E HELPERS
// ==========================================
// ==========================================
// CÂMERA E SCANNER (OTIMIZADO PARA iOS)
// ==========================================
function abrirScanner() {
    document.getElementById('modalScanner').classList.add('active');
    
    // Configuração específica para forçar compatibilidade em dispositivos móveis
    html5QrCode = new Html5QrcodeScanner("reader", { 
        fps: 10, 
        qrbox: { width: 250, height: 250 },
        aspectRatio: 1.0,
        // Força a prioridade para a câmera do dispositivo em vez de arquivos
        supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA] 
    });
    
    html5QrCode.render((text) => {
        document.getElementById('codigo').value = text;
        if (text.length >= 10) document.getElementById('isbn').value = text;
        fecharModal('modalScanner');
    }, (error) => {
        // Silencia os avisos de "QR Code não encontrado no frame atual" para não poluir o console
    });
}

async function abrirCamera() {
    document.getElementById('modalCamera').classList.add('active');
    const video = document.getElementById('videoCamera');
    
    // Injeção forçada via JavaScript para garantir que o Safari obedeça
    video.setAttribute('autoplay', '');
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');

    try {
        // Tenta pegar a câmera traseira especificamente
        streamCamera = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: { ideal: "environment" } },
            audio: false 
        });
        video.srcObject = streamCamera;
    } catch (err) {
        console.error("Erro na câmera:", err);
        if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
            alert("No iPhone, a câmera só funciona se o site tiver HTTPS (cadeado seguro).");
        } else {
            alert("Acesso à câmera negado. Vá aos Ajustes do iPhone > Safari e permita a Câmera.");
        }
        fecharModal('modalCamera');
    }
}

function capturarFoto() {
    const video = document.getElementById('videoCamera');
    const canvas = document.getElementById('canvasCamera') || document.createElement('canvas');
    const larguraAlvo = 400;
    const escala = larguraAlvo / video.videoWidth;
    canvas.width = larguraAlvo;
    canvas.height = video.videoHeight * escala;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    atualizarPreviewCapa(canvas.toDataURL('image/jpeg', 0.6));
    fecharModal('modalCamera');
}

function atualizarPreviewCapa(dado) {
    const img = document.getElementById('previewCapaForm');
    const texto = document.getElementById('previewCapaTexto');
    const hidden = document.getElementById('capaBase64');
    
    if (dado) {
        img.src = dado;
        hidden.value = dado;
        img.classList.remove('hidden');
        texto.classList.add('hidden');
    } else {
        img.classList.add('hidden');
        texto.classList.remove('hidden');
        hidden.value = "";
    }
}

function preencherFormulario(l) {
    document.getElementById('livroId').value = l.id;
    document.getElementById('codigo').value = l.codigo_barra;
    document.getElementById('isbn').value = l.isbn;
    document.getElementById('titulo').value = l.titulo;
    document.getElementById('autor').value = l.autor;
    document.getElementById('quantidade').value = l.quantidade;
    document.getElementById('genero').value = l.genero;
    document.getElementById('local').value = l.local;
    document.getElementById('ano').value = l.ano;
    document.getElementById('editora').value = l.editora;
    atualizarPreviewCapa(l.capa);
}

function limparFormulario() {
    document.getElementById('formLivro').reset();
    document.getElementById('livroId').value = "";
    atualizarPreviewCapa(null);
}

function fecharModal(id) {
    if (id === 'modalScanner' && html5QrCode) html5QrCode.clear().catch(()=>{});
    if (id === 'modalCamera' && streamCamera) streamCamera.getTracks().forEach(t => t.stop());
    document.getElementById(id).classList.remove('active');
}