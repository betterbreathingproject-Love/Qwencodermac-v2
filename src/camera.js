import { PerspectiveCamera } from 'three';

export class Camera {
    constructor() {
        this.camera = new PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        
        this.camera.position.set(5, 5, 5);
        this.camera.lookAt(0, 1, 0);

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
        });
    }

    get() {
        return this.camera;
    }
}