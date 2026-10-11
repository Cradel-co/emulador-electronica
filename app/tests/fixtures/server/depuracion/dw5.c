struct Punto { short x; short y; };
struct Estado {
  int contador;
  unsigned char banderas : 3;
  unsigned char modo : 5;
  struct Punto pos[2];
  const char *nombre;
  float temperatura;
};
enum Color { ROJO = 1, VERDE = 2, AZUL = -1 };
struct Estado estado = { 7, 5, 9, { { 1, -2 }, { 3, 4 } }, "hola", 21.5f };
enum Color color = VERDE;
int matriz[2][3] = { { 1, 2, 3 }, { 4, 5, 6 } };
static int privada = 99;
int usar(void) { static int llamadas = 0; llamadas++; return estado.contador + privada + llamadas; }
int _start(void) {
  int t = 0;
  for (;;) {
    t += usar();
    estado.contador = t;
  }
  return 0;
}
