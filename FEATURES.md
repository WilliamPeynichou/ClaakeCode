# Sinew — Fonctionnalités

> Petite carte vulgarisée de ce que sait faire l'app. Pensée pour des non-tech.
> On enrichit fichier par fichier.

---

## 🧭 Les 3 modes de travail

Sinew propose trois "humeurs" de travail pour l'agent. On les choisit selon le besoin du moment.

### ⚡ Mode Act
Le mode classique : tu demandes, l'agent fait. Il lit, modifie, lance des commandes, applique des patchs. C'est l'équivalent d'un développeur qui exécute directement la tâche.

### 🎯 Mode Goal
Tu donnes un **objectif** (pas une tâche unique), et l'agent travaille en **autonomie** sur plusieurs tours d'affilée jusqu'à ce que l'objectif soit vraiment atteint. À chaque tour il fait le point sur ce qui reste à faire, reprend là où il s'était arrêté, et ne s'arrête que lorsqu'il a audité que tout est bien terminé. C'est lui qui doit explicitement déclarer "objectif atteint" pour clôturer — sinon, ça continue.

### 🧠 Mode Plan *(la particularité Sinew)*
Contrairement aux modes "plan" des autres agents de coding qui pondent un plan en un coup, le mode Plan de Sinew **ouvre une session de questions-réponses non-stop**. L'agent explore le code, puis te pose une question. Tu réponds, il explore davantage, te pose la question suivante. Et ainsi de suite — **sans jamais sortir du loop tout seul**.

Le plan n'est rédigé qu'au moment où **toi**, l'utilisateur, tu cliques sur **"Send and stop questions"**. Résultat : un plan beaucoup plus riche et précis, car nourri par autant d'allers-retours que tu le souhaites.

En bonus, le plan final est volontairement **rédigé sans jargon** (pas de code, pas de noms de fichiers, pas de commandes) — il décrit *ce que* le système doit faire, jamais *comment* le coder. N'importe qui peut le lire.

---
