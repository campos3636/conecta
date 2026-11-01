# Campos Calls

Protótipo de chamadas de vídeo em grupo com até 10 participantes e compartilhamento de tela.

## Executar

Na pasta do projeto, execute `node server.js` e acesse `http://localhost:8000` em um navegador moderno. Crie uma sala, escolha seu nome, ícone e microfone e compartilhe o convite. O microfone requer autorização; a câmera só é solicitada quando você decide ligá-la. Cada participante precisa abrir o aplicativo em um endereço acessível no seu próprio dispositivo; para acesso pela internet, publique os arquivos em um servidor HTTPS. Câmera, microfone e tela exigem HTTPS ou localhost.

É possível entrar sem câmera física; o microfone continua necessário. Com a câmera desligada, todos veem o ícone escolhido na entrada. O ícone fica salvo no perfil do navegador e a transmissão de tela continua em uma janela separada.

O chat da chamada permite texto e imagens JPEG, PNG, WebP ou GIF de até 512 KB, enviadas pelo botão de anexar ou coladas com Ctrl+V no painel do chat. As mensagens são mantidas somente durante a sessão e não são entregues a quem entra depois; não há garantia de entrega ou histórico persistente.

## Compartilhamento de tela

- No computador, use um navegador atualizado com `getDisplayMedia`. Muitos navegadores de celular permitem assistir, mas não transmitir a tela.
- O navegador solicita a seleção da tela ou janela em cada compartilhamento. Para áudio do sistema no Edge/Chrome, escolha a tela inteira e ative a opção de áudio quando disponível.
- Se a captura falhar por incompatibilidade ou por indisponibilidade do áudio do sistema, o aviso oferece uma tentativa manual em **modo compatível**, sem áudio e sem exigir uma qualidade específica. Negativas de permissão não são contornadas ou repetidas automaticamente.
- Falhas ao enviar a transmissão a um participante não encerram a captura dos demais. A captura local e a conexão remota são etapas diferentes: conseguir abrir a seleção da tela não garante que a rede permitirá transmitir o vídeo.

## Testes de desenvolvimento

O site não precisa de dependências npm para rodar. Para os testes automatizados, execute `npm ci` e `npm test`. Por padrão, os testes usam o Edge instalado no Windows; `TEST_BROWSER_CHANNEL` pode selecionar outro canal compatível com Playwright.

Os testes usam perfis separados, PeerJS/WebRTC reais e sinalização local com áudio/vídeo gerados, sem acessar microfone, câmera ou tela reais. Cobrem duas transmissões simultâneas, entrada de um terceiro participante, reinício da transmissão, avatares, estados de câmera/microfone, volume independente, erros de captura, modo compatível e altura da página. Não substituem testes em dispositivos e redes diferentes, nem validam a captura real do sistema operacional.

## Limitações

- É um protótipo sem autenticação, senha de sala, gravação ou recuperação de conexão. Não use para reuniões confidenciais.
- Um ID local e um bloqueio entre abas limitam o navegador a uma sessão por vez. Não é uma identificação de pessoa: perfis diferentes, navegação anônima, outros dispositivos ou a limpeza dos dados podem gerar outro ID. Um limite real por pessoa exige contas e autenticação no servidor.
- Usa PeerJS e seu servidor público de sinalização, carregados pela internet. O anfitrião deve permanecer na sala. A disponibilidade do serviço externo não é garantida.
- As conexões de mídia são diretas entre participantes (malha WebRTC). Até 10 pessoas são permitidas, mas a qualidade e a estabilidade com muitos usuários dependem muito de rede e hardware. Algumas redes podem impedir a conexão porque não há servidor TURN configurado.
- O compartilhamento solicita 1080p a 60 fps; resolução e taxa reais dependem do navegador, da rede e da máquina. O áudio da tela é opcional e depende do navegador, do conteúdo escolhido e da opção de compartilhamento de áudio. Há controles separados para o microfone e para o áudio da transmissão.
- Para produção e chamadas confiáveis com 10 pessoas, recomenda-se uma infraestrutura de videoconferência com SFU, servidores STUN/TURN, autenticação e hospedagem HTTPS.
