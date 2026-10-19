---
tipo: adr
estado: proposed
fecha: '2026-09-19'
contexto: 'Existen dos dispatchers no integrados; el corto carece de gate de ownership MC y el candidato seguro permanece sin commit ni PR.'
decision: 'A4S adoptará como único reconciliador canónico a4s-reconcile con gate fail-closed por owner, lease e identidad de Mission Control; no operará hasta registrar ese owner y retirar el loop alterno.'
alternativas: 'Conservar dispatch-reconcile corto: rechazado porque puede mutar sin gate MC; fusionar ambos: rechazado porque duplica loops; diferir: rechazado por prioridad P0.'
consecuencias: 'Evita doble dispatch y protege el control-plane; exige un Bead de ownership MC, pruebas, commit, revisión, merge y retiro explícito del dispatcher alterno.'
pendientes: 'Verificar forma de metadata y heartbeat del owner MC; decidir cómo retirar el commit 2a3fd4d sin perder sus tests útiles.'
---
# 0022. Reconciliador gobernado por owner mc

## Contexto
Existen dos dispatchers no integrados; el corto carece de gate de ownership MC y el candidato seguro permanece sin commit ni PR.

## Decisión
A4S adoptará como único reconciliador canónico a4s-reconcile con gate fail-closed por owner, lease e identidad de Mission Control; no operará hasta registrar ese owner y retirar el loop alterno.

## Alternativas descartadas
Conservar dispatch-reconcile corto: rechazado porque puede mutar sin gate MC; fusionar ambos: rechazado porque duplica loops; diferir: rechazado por prioridad P0.

## Consecuencias
Evita doble dispatch y protege el control-plane; exige un Bead de ownership MC, pruebas, commit, revisión, merge y retiro explícito del dispatcher alterno.

## Pendientes
Verificar forma de metadata y heartbeat del owner MC; decidir cómo retirar el commit 2a3fd4d sin perder sus tests útiles.
