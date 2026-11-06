# Campos Calls

Protótipo de chamadas de vídeo em grupo com até 10 participantes e compartilhamento de tela.

## Executar

Na pasta do projeto, execute `node server.js` e acesse `http://localhost:8000` em um navegador moderno. Crie uma sala, escolha seu nome, ícone e microfone e compartilhe o convite. O microfone requer autorização; a câmera só é solicitada quando você decide ligá-la. Cada participante precisa abrir o aplicativo em um endereço acessível no seu próprio dispositivo; para acesso pela internet, publique os arquivos em um servidor HTTPS. Câmera, microfone e tela exigem HTTPS ou localhost.

É possível entrar sem câmera física; o microfone continua necessário. Com a câmera desligada, todos veem o ícone escolhido na entrada. O ícone fica salvo no perfil do navegador e a transmissão de tela continua em uma janela separada.

O chat da chamada permite texto e imagens JPEG, PNG, WebP ou GIF de até 512 KB, enviadas pelo botão de anexar ou coladas com Ctrl+V no painel do chat. As mensagens são mantidas somente durante a sessão e não são entregues a quem entra depois; não há garantia de entrega ou histórico persistente.

## Compartilhamento de tela

- Microfone, câmera, tela e áudio da tela usam **uma única conexão de mídia por dupla de participantes**, com quatro faixas RTP reservadas e BUNDLE. Iniciar, parar, recuperar ou trocar a câmera usa `replaceTrack`, sem abrir outra chamada de mídia ou negociar outro caminho ICE para a live. O chat/controle da sala continua usando as conexões de dados existentes.
- Os canais de microfone e áudio da tela e as duas faixas de vídeo continuam separados na interface. As faixas são identificadas pelos MIDs negociados, não pela ordem de chegada ou por IDs de track que o navegador pode reescrever.
- **Todos devem atualizar a página e entrar em uma sala nova.** A versão anterior, com chamadas de tela separadas, não é compatível com este protocolo de mídia.
- No computador, use um navegador atualizado com `getDisplayMedia`. Muitos navegadores de celular permitem assistir, mas não transmitir a tela.
- O navegador solicita a seleção da tela ou janela em cada compartilhamento. Para áudio do sistema no Edge/Chrome, escolha a tela inteira e ative a opção de áudio quando disponível.
- No Chrome/Windows, selecione o monitor e ative **Compartilhar áudio do sistema** antes de confirmar. Para um vídeo tocando no próprio navegador, outra opção é **Guia do Chrome → guia onde o som toca → Compartilhar áudio da guia**. Áudio de uma guia não inclui o som de jogos ou programas externos. A disponibilidade e a autorização são controladas pelo navegador e pelo sistema; o site não pode forçar essa opção.
- O pedido de captura solicita áudio explicitamente, sem os filtros de voz de cancelamento de eco, redução de ruído e ganho automático, e não pede para silenciar a reprodução local. Esses filtros continuam habilitados separadamente para o microfone.
- Se a imagem chegar sem uma faixa de áudio, o aviso informa que **o navegador não forneceu áudio**, sem tratar isso como uma permissão negada. O botão **Trocar para guia com áudio** encerra a transmissão atual e abre uma nova seleção, somente após um clique do usuário. Ele não contorna autorizações nem captura áudio automaticamente.
- Se a captura falhar por incompatibilidade ou por indisponibilidade do áudio do sistema, o aviso oferece uma tentativa manual em **modo compatível**, sem áudio e sem exigir uma qualidade específica. Negativas de permissão não são contornadas ou repetidas automaticamente.
- Falhas ao enviar a transmissão a um participante não encerram a captura dos demais. A captura local e a conexão remota são etapas diferentes: conseguir abrir a seleção da tela não garante que a rede permitirá transmitir o vídeo.
- Se não chegar nenhum quadro real da tela em cerca de 12 segundos, o receptor solicita até duas tentativas automáticas. Cada tentativa reativa somente as faixas de tela daquele participante na **mesma conexão de mídia**, sem fechar a chamada, mantendo a captura, o áudio, o volume e o destaque. A negociação inicial prefere VP8 e a recuperação tenta limitar o envio a 720p/30 fps e 2,5 Mbps quando o navegador aceita esses parâmetros. Os demais espectadores continuam com seu envio original. Isso não substitui um servidor TURN quando a própria conexão da chamada é impedida pela rede.
- O botão **↻** na transmissão permite solicitar essa recuperação manual. O painel **Status da transmissão** distingue o vídeo real confirmado pelo receptor dos quadros de reserva e do envio sem confirmação. **Copiar diagnóstico** identifica o transporte como `shared-media` e copia estados, contadores da faixa de tela (não da câmera), codec, dimensões de captura e versão do navegador; não inclui imagens, mensagens do chat, candidatos ICE, endereços de rede ou credenciais.
- O diagnóstico de áudio diferencia ausência de faixa na captura, faixa pausada/encerrada, pacotes no envio/recepção e reprodução local suspensa. Contadores WebRTC de energia podem ficar em zero mesmo quando há som sendo reproduzido via Web Audio; por isso há também um nível de sinal agregado medido antes do controle de volume. Isso não grava o áudio nem garante que o usuário esteja ouvindo: volume, dispositivo de saída e bloqueio de reprodução também importam. Quando o navegador suspende a reprodução, o painel oferece **Ativar som recebido** após uma interação do usuário.

## Testes de desenvolvimento

O site não precisa de dependências npm para rodar. Para os testes automatizados, execute `npm ci` e `npm test`. Por padrão, os testes usam o Edge instalado no Windows; `TEST_BROWSER_CHANNEL` pode selecionar outro canal compatível com Playwright.

Os testes usam perfis separados, PeerJS/WebRTC reais e sinalização local com áudio/vídeo gerados, sem acessar microfone, câmera ou tela reais. Cobrem duas transmissões simultâneas, entrada de um terceiro participante, reinício da transmissão, avatares, estados de câmera/microfone, volume independente, erros de captura, modo compatível e altura da página. Verificam que o mesmo RTCPeerConnection e o mesmo transporte DTLS/SCTP são mantidos, mesmo quando novas chamadas de mídia são proibidas no teste. Padrões de vídeo e tons de 440/880 Hz verificam a separação entre câmera, voz, tela e áudio da live. Também cobrem falha em uma só direção, recuperação direta entre convidados, limite de tentativas, confirmações antigas, entradas simultâneas e rejeição de ofertas de mídia de peers não admitidos. Não substituem testes em dispositivos e redes diferentes, nem validam a captura real do sistema operacional.

Os testes de áudio também simulam imagem sem faixa de som, troca manual para uma guia sem recriar a chamada, encerramento apenas do áudio e retomada de reprodução. A captura física do Chrome/Windows ainda precisa ser validada no computador afetado; testar mídia gerada no Edge não comprova que o Chrome disponibilizará áudio do sistema em todos os dispositivos.

## Limitações

- É um protótipo sem autenticação, senha de sala, gravação ou recuperação geral da chamada após perda de conexão. Não use para reuniões confidenciais.
- Um ID local e um bloqueio entre abas limitam o navegador a uma sessão por vez. Não é uma identificação de pessoa: perfis diferentes, navegação anônima, outros dispositivos ou a limpeza dos dados podem gerar outro ID. Um limite real por pessoa exige contas e autenticação no servidor.
- Usa PeerJS e seu servidor público de sinalização, carregados pela internet. O anfitrião deve permanecer na sala. A disponibilidade do serviço externo não é garantida.
- As conexões de mídia são diretas entre participantes (malha WebRTC), com STUN do Google configurado explicitamente. Não foi adicionado Metered nem outro serviço de relay. Não há TURN dedicado validado; os endpoints TURN padrão da biblioteca anterior não retornaram endereços nos testes de DNS. Algumas redes ainda podem impedir a chamada inteira. Até 10 pessoas são permitidas, mas qualidade e estabilidade com muitos usuários dependem muito de rede e hardware.
- O compartilhamento solicita 1080p a 60 fps; resolução e taxa reais dependem do navegador, da rede e da máquina. O áudio da tela é opcional e depende do navegador, do conteúdo escolhido e da opção de compartilhamento de áudio. Há controles separados para o microfone e para o áudio da transmissão.
- Para produção e chamadas confiáveis com 10 pessoas, recomenda-se uma infraestrutura de videoconferência com SFU, servidores STUN/TURN, autenticação e hospedagem HTTPS.
