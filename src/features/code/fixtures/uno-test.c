// Built with: avr-gcc -mmcu=atmega328p -Os -o test.elf uno-test.c && avr-objcopy -O ihex -R .eeprom test.elf uno-test.hex
// A test program for the simulator: says hello on serial, blinks D13, and echoes typed bytes back
// in upper case, with D2 (input, pulled up) read into the reply.
#define F_CPU 16000000UL
#include <avr/io.h>
#include <util/delay.h>
static void put(char c) { while (!(UCSR0A & (1 << UDRE0))); UDR0 = c; }
static void say(const char *s) { while (*s) put(*s++); }
int main(void) {
  UBRR0H = 0; UBRR0L = 103;               // 9600 baud at 16 MHz
  UCSR0B = (1 << TXEN0) | (1 << RXEN0);
  UCSR0C = (1 << UCSZ01) | (1 << UCSZ00);
  DDRB |= (1 << PB5);                     // D13 out
  PORTD |= (1 << PD2);                    // D2 in, pulled up
  say("hello\n");
  for (;;) {
    PORTB ^= (1 << PB5);
    for (int i = 0; i < 100; i++) {
      if (UCSR0A & (1 << RXC0)) { char c = UDR0; if (c >= 'a' && c <= 'z') c -= 32; put(c); put((PIND & (1 << PD2)) ? '1' : '0'); }
      _delay_ms(1);
    }
  }
}
