# Lucas Belucci Bellini — Plano de contribuições para o REA

**Perfil GitHub:** [@Lucas-Belucci-Bellini](https://github.com/Lucas-Belucci-Bellini)  
**Repositório:** [Lucas-Belucci-Bellini/rea](https://github.com/Lucas-Belucci-Bellini/rea)  
**Branch de trabalho:** `feat/lucas-profile-roadmap`  
**Base:** `feat/claude-code-codex-plugin`

> Este documento descreve meus objetivos pessoais de experimentação e contribuição. Não representa uma declaração oficial dos mantenedores do REA nem afirma que as funcionalidades planejadas já estão implementadas.

## Por que comecei a trabalhar nos plugins

Decidi investigar e mexer na integração por um motivo prático: **não estava conseguindo instalar e usar o plugin no Claude Code da forma que precisava**. Em vez de depender de uma configuração que eu não conseguia fazer funcionar, comecei a estudar como as peças se conectam — plugin, skills, configuração MCP, instruções do agente e ferramentas disponíveis.

O objetivo não é apenas fazer os arquivos existirem. Quero conseguir instalar, iniciar, testar e diagnosticar a integração, entendendo o que cada parte faz e quais limitações ainda existem.

## O que pretendo adicionar

### 1. Integração confiável com Claude Code e Codex
- Documentar a configuração necessária em cada cliente, sem misturar formatos incompatíveis.
- Criar passos de instalação, verificação, atualização e remoção.
- Detectar pré-requisitos ausentes e mostrar erros com instruções claras.
- Preservar configurações existentes e apresentar as alterações antes de aplicá-las.
- Documentar como reiniciar os clientes e confirmar que o MCP está realmente conectado.

### 2. Skills práticas e verificáveis
- Criar skills focadas em tarefas reais, com escopo, pré-requisitos, entradas, saídas e critérios de conclusão.
- Incluir exemplos pequenos e reproduzíveis, além de casos de falha.
- Separar instruções de skill das ferramentas que precisam ser fornecidas por MCP ou pelo ambiente.
- Evitar skills duplicadas, vagas ou que afirmem capacidades inexistentes.
- Construir uma biblioteca que possa crescer gradualmente, com a meta de chegar a pelo menos 250 skills até o fim de 2026, desde que cada uma tenha utilidade e validação.

### 3. Engenharia reversa responsável e orientada por evidências
- Estudar arquitetura, fluxo de dados, sistemas de arquivos, APIs e comportamento observável.
- Registrar evidências, hipóteses, incertezas e limites de cada análise.
- Usar as descobertas para implementar soluções próprias, sem copiar código protegido nem presumir que uma implementação em outra linguagem funcionará sem adaptação.
- Manter os testes limitados a software e materiais que eu possuo ou tenho autorização para analisar.

### 4. Aplicação aos meus projetos
- **NEXORA:** estudar conceitos de engines, mundos em blocos, chunks, renderização, física, streaming, salvamento, simulação e modding para orientar uma engine própria em Rust.
- **Orbital-Salvage:** analisar sistemas de jogo, automação, exploração, interação e progressão, traduzindo observações em requisitos e protótipos próprios.
- **ATM10:** organizar informações técnicas do modpack e investigar problemas reproduzíveis para ajudar no diagnóstico; isso não significa que todo o modpack ou seus arquivos serão incorporados ao REA.
- **Outros projetos:** reutilizar padrões de documentação, validação e testes sem assumir que todos os projetos compartilham a mesma arquitetura.

## Princípios de implementação

1. **Não confundir configuração com funcionamento.** Um arquivo presente não prova que o plugin está carregando.
2. **Testar os dois clientes separadamente.** O sucesso no Claude Code não comprova o sucesso no Codex, nem o contrário.
3. **Não alterar a branch principal sem revisão.** O trabalho deve permanecer em branches de feature e ser proposto por pull request.
4. **Registrar resultados reais.** Diferenciar claramente testes executados, testes bloqueados, testes não executados e hipóteses.
5. **Não esconder falhas.** Erros, dependências ausentes e limitações devem aparecer na documentação.
6. **Respeitar licenças e autoria.** Usar engenharia reversa para aprender e criar implementações próprias, respeitando autorização e termos aplicáveis.
7. **Priorizar qualidade à contagem.** A meta de skills é um objetivo de longo prazo, não motivo para publicar conteúdo duplicado ou não testado.

## Plano inicial de validação

- [ ] Confirmar que os arquivos do plugin seguem os formatos esperados pelos clientes.
- [ ] Validar a estrutura e o frontmatter de cada skill.
- [ ] Verificar caminhos relativos, nomes, scripts e instruções de instalação.
- [ ] Testar a instalação em ambiente limpo, sem sobrescrever configuração do usuário.
- [ ] Confirmar se Claude Code detecta a skill e o servidor MCP.
- [ ] Confirmar separadamente a configuração e a descoberta de ferramentas no Codex.
- [ ] Executar um teste simples de chamada MCP e registrar o resultado.
- [ ] Testar falhas esperadas: dependência ausente, configuração inválida e servidor indisponível.
- [ ] Documentar como desfazer a instalação.
- [ ] Abrir um pull request com resumo, evidências e limitações conhecidas.

## Estado atual

Este README registra a motivação e a direção planejada. **Os itens acima não devem ser interpretados como concluídos apenas por estarem documentados.** Cada integração e skill precisa de evidência própria antes de ser marcada como validada.

---

*Mantido por [Lucas-Belucci-Bellini](https://github.com/Lucas-Belucci-Bellini), como plano pessoal de estudo e contribuição.*
