# Lucas Belucci Bellini — Plano de contribuições para o REA

**Perfil GitHub:** [@Lucas-Belucci-Bellini](https://github.com/Lucas-Belucci-Bellini)  
**Repositório:** [Lucas-Belucci-Bellini/rea](https://github.com/Lucas-Belucci-Bellini/rea)  
**Branch de trabalho:** `feat/lucas-profile-roadmap`  
**Base:** `feat/claude-code-codex-plugin`

> Este documento descreve meus objetivos pessoais de experimentação e contribuição. Não representa uma declaração oficial dos mantenedores do REA nem afirma que as funcionalidades planejadas já estão implementadas.

## Por que fiz este fork

Eu normalmente não tenho o costume de sair mexendo nos repositórios de outras pessoas. Neste caso, porém, era um projeto que eu queria muito conseguir usar, mas não consegui fazer a integração funcionar como precisava. Em vez de simplesmente desistir, decidi criar um fork para estudar o projeto e tentar ajudar a resolver os problemas que encontrei, mantendo minhas experiências isoladas da branch principal.

Minha ideia é seguir uma ordem: **primeiro fortalecer e validar as skills; depois, construir e configurar um servidor MCP que o Claude consiga usar de verdade**. Quero que as skills sejam úteis, claras e testáveis, e que o MCP permita ao cliente descobrir e executar ferramentas de maneira verificável — não apenas ter arquivos de configuração que parecem corretos.

Esse trabalho também tem um objetivo concreto para mim: preciso dessas ferramentas para avançar no [NEXORA](https://github.com/Lucas-Belucci-Bellini/NEXORA), meu projeto de engine. Quero estudar como as ferramentas e as engines existentes são organizadas, entender seus conceitos e aplicar o que aprender em uma implementação própria. Como o NEXORA é desenvolvido em Rust, não vou presumir que código de uma engine feita em outra linguagem possa ser copiado diretamente; a intenção é compreender a arquitetura e adaptar as ideias com testes.

Fiz o fork para poder investigar, experimentar e propor melhorias por meio de uma branch própria e de pull requests. Não estou afirmando que já resolvi os problemas originais: quero documentar o que funciona, o que falha e o que ainda precisa ser comprovado.

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
