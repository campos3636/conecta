# Conecta

Protótipo de chamadas de vídeo em grupo com até 10 participantes e compartilhamento de tela.

## Executar

Na pasta do projeto, execute `node server.js` e acesse `http://localhost:8000` em um navegador moderno. Permita o uso de câmera e microfone. Crie uma sala e compartilhe o convite ou o código. Cada participante precisa abrir o aplicativo em um endereço acessível no seu próprio dispositivo; para acesso pela internet, publique os arquivos em um servidor HTTPS. Câmera, microfone e tela exigem HTTPS ou localhost.

É possível entrar sem câmera física; o microfone continua necessário. Nesse caso, a chamada exibe uma imagem de substituição até que a tela seja compartilhada.

## Limitações

- É um protótipo sem autenticação, senha de sala, gravação ou recuperação de conexão. Não use para reuniões confidenciais.
- Um ID local e um bloqueio entre abas limitam o navegador a uma sessão por vez. Não é uma identificação de pessoa: perfis diferentes, navegação anônima, outros dispositivos ou a limpeza dos dados podem gerar outro ID. Um limite real por pessoa exige contas e autenticação no servidor.
- Usa PeerJS e seu servidor público de sinalização, carregados pela internet. O anfitrião deve permanecer na sala. A disponibilidade do serviço externo não é garantida.
- As conexões de mídia são diretas entre participantes (malha WebRTC). Até 10 pessoas são permitidas, mas a qualidade e a estabilidade com muitos usuários dependem muito de rede e hardware. Algumas redes podem impedir a conexão porque não há servidor TURN configurado.
- O compartilhamento solicita até 1080p a 30 fps; resolução e taxa reais dependem do navegador, da rede e da máquina. Não compartilha o áudio da tela.
- Para produção e chamadas confiáveis com 10 pessoas, recomenda-se uma infraestrutura de videoconferência com SFU, servidores STUN/TURN, autenticação e hospedagem HTTPS.
