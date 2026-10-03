# ADR-0005: Policy engine determinista, fuera del LLM, con taint tracking

**Estado:** aceptado · 2026-10-03

## Contexto
El modelo nunca debe controlar sin restricciones el computador. Además, el contenido externo (web,
archivos, correos) puede contener inyección de prompts.

## Decisión
- El LLM **propone** acciones; el `PolicyEngine` (código determinista) **decide**: `allow | confirm | deny`.
- Niveles: `read < reversible < sensitive < critical`. `critical` siempre exige confirmación explícita.
- El motor envuelve **cada** herramienta en el registro, incluidas las de servidores MCP de terceros.
- **Taint tracking:** el contenido con procedencia `untrusted_external` marca la cadena como contaminada;
  desde ese punto, acciones `sensitive`/`critical` exigen confirmación aunque el nivel base no lo pida.
- Toda decisión se registra en un log de auditoría.
- Las credenciales no son memoria: el modelo recibe referencias, nunca texto plano (bóveda en V2).

## Consecuencias
+ Superficie de ataque acotada y testeable. − Más confirmaciones; se mitiga con permisos por herramienta y alcance.
