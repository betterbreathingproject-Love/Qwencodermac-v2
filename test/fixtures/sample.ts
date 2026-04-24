// Sample TypeScript fixture for AST search testing

interface User {
  id: number;
  name: string;
  email: string;
}

type Status = 'active' | 'inactive' | 'pending';

function createUser(name: string, email: string): User {
  return { id: Date.now(), name, email };
}

const getStatus = (user: User): Status => {
  return user.id > 0 ? 'active' : 'inactive';
};

class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  findById(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }
}

export { User, Status, createUser, getStatus, UserService };
