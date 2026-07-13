import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Solution Engineer challenge, see INSTRUCTIONS.md';
  }
}
