# MemoFlag

Jogo de memória de bandeiras para jogar ao vivo com amigos (até 8 jogadores), ao estilo Kahoot.
O ecrã do host (TV/projetor) mostra as bandeiras; cada jogador responde no telemóvel.

## Como jogar
1. O host abre o site e cria a sala (código + QR).
2. Os jogadores entram em `/jogar` com o código e o nome.
3. 10 bandeiras passam no ecrã; depois aparece uma grelha 5×5 e cada jogador marca (máx. 5) as que viu.
4. +1 ponto por bandeira certa. Desempate pelo tempo total de resposta.

## Executar localmente
```bash
npm install
npm start
```
Abre `http://localhost:3000`. A porta pode ser definida com a variável `PORT`.

## Render
Web Service com Node: build `npm install`, start `npm start`.

## Ranking
`GET /api/salas/:codigo/ranking` devolve a classificação da sala.
